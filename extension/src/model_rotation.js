// model_rotation.js — Smart Model Rotation with Stability Ratings.
//
// Manages a pool of AI models ranked by stability rating (0–100%).
// The primary model (first in list) is preferred; the agent automatically
// falls back to secondary models when the primary degrades, and strives
// to return to the primary once it recovers.
//
// Rating mechanics:
//   - All models start at 100%
//   - Failure penalty: −25 (first), −35 (consecutive), −40 (critical/persistent)
//   - Recovery: +3/step for inactive models, +2/step for active model
//   - Caps: min 0, max 100
//   - Anti-flip-flop hysteresis: switch requires +10 advantage
//
// This module is stateless w.r.t. chrome.storage — it lives in runtime only.

import { broadcast } from './bus.js';

// ============================================================
// CONSTANTS
// ============================================================

const RATING_INITIAL = 100;
const RATING_MIN = 0;
const RATING_MAX = 100;
const RATING_PENALTY_FAIL = -25;
const RATING_PENALTY_CONSECUTIVE = -35;
const RATING_PENALTY_CRITICAL = -40;
const RATING_RECOVERY_INACTIVE = 3;   // per step, for non-active models
const RATING_RECOVERY_ACTIVE = 2;     // per step, for the active model
const SWITCH_THRESHOLD_DEFAULT = 60;
const RECOVERY_THRESHOLD_DEFAULT = 80;
const HYSTERESIS_SWITCH = 10;   // alternative must be this much better to switch
const HYSTERESIS_RECOVERY = 5;  // primary must be within this of active to return
const CONSECUTIVE_FAIL_ESCALATION = 2; // after N consecutive fails on same model, escalate penalty

// ============================================================
// MODEL ENTRY
// ============================================================

/**
 * @typedef {Object} ModelEntry
 * @property {string} id       — model identifier (e.g. "google/gemini-3.7-flash")
 * @property {number} rating   — current stability rating 0–100
 * @property {number} priority — fixed order from settings (0 = primary)
 * @property {number} successCount — successful calls in this session
 * @property {number} failCount    — failed calls in this session
 * @property {number} consecutiveFails — consecutive failures on this model
 */

function createModelEntry(id, priority) {
  return {
    id,
    rating: RATING_INITIAL,
    priority,
    successCount: 0,
    failCount: 0,
    consecutiveFails: 0
  };
}

// ============================================================
// MODEL ROTATION MANAGER
// ============================================================

export class ModelRotationManager {
  /**
   * @param {string[]} modelIds — ordered list: [primary, fallback1, fallback2]
   * @param {Object} [opts]
   * @param {number} [opts.switchThreshold]  — default 60
   * @param {number} [opts.recoveryThreshold] — default 80
   */
  constructor(modelIds, opts = {}) {
    // Filter out empty/undefined entries
    const ids = (modelIds || []).filter(Boolean);
    if (ids.length === 0) {
      throw new Error('ModelRotationManager: at least one model required');
    }

    /** @type {ModelEntry[]} */
    this.models = ids.map((id, i) => createModelEntry(id, i));

    this.switchThreshold = opts.switchThreshold ?? SWITCH_THRESHOLD_DEFAULT;
    this.recoveryThreshold = opts.recoveryThreshold ?? RECOVERY_THRESHOLD_DEFAULT;

    /** Index into this.models for the currently active model */
    this.activeIndex = 0;

    /** Rotation event log (for session summary) */
    this.rotationLog = [];

    /** Total steps processed (for inactive recovery) */
    this.totalSteps = 0;

    /** Set of model IDs that were involved in this session */
    this._usedModels = new Set([ids[0]]);
  }

  // ──────────────────────────────────────────────────────────
  // PUBLIC API
  // ──────────────────────────────────────────────────────────

  /**
   * Get the currently active model ID.
   * @returns {string}
   */
  getActiveModelId() {
    return this.models[this.activeIndex].id;
  }

  /**
   * Get the active ModelEntry.
   * @returns {ModelEntry}
   */
  getActiveModel() {
    return this.models[this.activeIndex];
  }

  /**
   * Get all model entries (for UI/status display).
   * @returns {ModelEntry[]}
   */
  getAllModels() {
    return this.models;
  }

  /**
   * Called after a SUCCESSFUL model response.
   * Increases active model's rating, recovers inactive models.
   * Checks if primary model has recovered enough to switch back.
   *
   * @returns {{ switched: boolean, newModelId?: string }}
   */
  onSuccess() {
    const active = this.models[this.activeIndex];
    active.successCount++;
    active.consecutiveFails = 0; // reset consecutive counter

    // Active model gets +2 rating for each success
    this._adjustRating(active, RATING_RECOVERY_ACTIVE);

    // Recover inactive models (+3 per step)
    this.totalSteps++;
    for (let i = 0; i < this.models.length; i++) {
      if (i !== this.activeIndex) {
        this._adjustRating(this.models[i], RATING_RECOVERY_INACTIVE);
      }
    }

    // Check if we should return to the primary model
    return this._checkRecovery();
  }

  /**
   * Called after a FAILED model call.
   * Penalizes the active model's rating and potentially switches.
   *
   * @param {Object} [opts]
   * @param {boolean} [opts.critical] — if true, applies heavier penalty
   * @returns {{ switched: boolean, newModelId?: string, allExhausted: boolean }}
   */
  onFailure(opts = {}) {
    const active = this.models[this.activeIndex];
    active.failCount++;
    active.consecutiveFails++;

    // Determine penalty severity
    let penalty;
    if (opts.critical) {
      penalty = RATING_PENALTY_CRITICAL;
    } else if (active.consecutiveFails >= CONSECUTIVE_FAIL_ESCALATION) {
      penalty = RATING_PENALTY_CONSECUTIVE;
    } else {
      penalty = RATING_PENALTY_FAIL;
    }

    this._adjustRating(active, penalty);

    // Try to find a better model
    const switchResult = this._selectBest();

    if (switchResult.index !== this.activeIndex) {
      const oldId = active.id;
      const newEntry = this.models[switchResult.index];

      this.activeIndex = switchResult.index;
      this._usedModels.add(newEntry.id);

      this.rotationLog.push({
        from: oldId,
        to: newEntry.id,
        reason: opts.critical ? 'critical_error' : 'rating_below_threshold',
        fromRating: active.rating,
        toRating: newEntry.rating,
        ts: Date.now()
      });

      broadcast({
        kind: 'model_rotation',
        from: oldId,
        to: newEntry.id,
        reason: opts.critical ? 'critical_error' : 'rating_degraded',
        fromRating: active.rating,
        toRating: newEntry.rating,
        allRatings: this._getRatingsSnapshot()
      });

      broadcast({
        kind: 'log',
        level: 'warn',
        text: 'Switch model: ' + this._shortName(oldId) + ' (' + active.rating + '%) -> ' + this._shortName(newEntry.id) + ' (' + newEntry.rating + '%)'
      });

      return {
        switched: true,
        newModelId: newEntry.id,
        allExhausted: false
      };
    }

    // No switch happened — check if ALL models are exhausted
    const allExhausted = this.models.every(m => m.rating <= RATING_MIN);
    if (allExhausted) {
      broadcast({
        kind: 'log',
        level: 'error',
        text: 'All models exhausted (rating 0%). Session will stop.'
      });
    }

    return {
      switched: false,
      newModelId: null,
      allExhausted
    };
  }

  /**
   * Get a summary object for session end / logging.
   */
  getSummary() {
    return {
      models: this.models.map(m => ({
        id: m.id,
        rating: m.rating,
        priority: m.priority,
        successCount: m.successCount,
        failCount: m.failCount
      })),
      rotationLog: [...this.rotationLog],
      usedModels: [...this._usedModels],
      totalRotations: this.rotationLog.length,
      totalSteps: this.totalSteps
    };
  }

  /**
   * Serialize for persistence (chrome.storage.session).
   * Returns a plain object.
   */
  serialize() {
    return {
      models: this.models.map(m => ({ ...m })),
      activeIndex: this.activeIndex,
      rotationLog: [...this.rotationLog],
      totalSteps: this.totalSteps,
      switchThreshold: this.switchThreshold,
      recoveryThreshold: this.recoveryThreshold,
      _usedModels: [...this._usedModels]
    };
  }

  /**
   * Deserialize from persisted state.
   * @param {Object} data — output of serialize()
   * @returns {ModelRotationManager}
   */
  static deserialize(data) {
    if (!data || !data.models || data.models.length === 0) return null;
    const mgr = new ModelRotationManager(
      data.models.map(m => m.id),
      { switchThreshold: data.switchThreshold, recoveryThreshold: data.recoveryThreshold }
    );
    mgr.models = data.models.map(m => ({ ...m }));
    mgr.activeIndex = data.activeIndex || 0;
    mgr.rotationLog = data.rotationLog || [];
    mgr.totalSteps = data.totalSteps || 0;
    mgr._usedModels = new Set(data._usedModels || [data.models[0]?.id]);
    return mgr;
  }

  /**
   * Check if the system only has one model (no rotation possible).
   */
  get isSingleModel() {
    return this.models.length <= 1;
  }

  // ──────────────────────────────────────────────────────────
  // PRIVATE
  // ──────────────────────────────────────────────────────────

  /**
   * Adjust a model's rating, clamped to [RATING_MIN, RATING_MAX].
   */
  _adjustRating(model, delta) {
    model.rating = Math.max(RATING_MIN, Math.min(RATING_MAX, model.rating + delta));
  }

  /**
   * Find the best model by rating (with hysteresis).
   * If the current model is still above switchThreshold, keep it.
   * Otherwise, pick the one with highest rating (if it beats current by HYSTERESIS_SWITCH).
   *
   * @returns {{ index: number, model: ModelEntry }}
   */
  _selectBest() {
    const current = this.models[this.activeIndex];

    // If current model is still healthy enough, keep it
    if (current.rating >= this.switchThreshold) {
      return { index: this.activeIndex, model: current };
    }

    // Find the model with the highest rating
    let bestIndex = 0;
    let bestRating = -1;
    for (let i = 0; i < this.models.length; i++) {
      if (this.models[i].rating > bestRating) {
        bestRating = this.models[i].rating;
        bestIndex = i;
      }
    }

    // Hysteresis: only switch if the best model is sufficiently better
    const best = this.models[bestIndex];
    if (bestIndex !== this.activeIndex && best.rating >= current.rating + HYSTERESIS_SWITCH) {
      return { index: bestIndex, model: best };
    }

    // Even with hysteresis, if current is at 0 and best is > 0, switch anyway
    if (current.rating <= RATING_MIN && best.rating > RATING_MIN) {
      return { index: bestIndex, model: best };
    }

    // Stay on current
    return { index: this.activeIndex, model: current };
  }

  /**
   * Check if we should return to the primary model.
   * Called after successful calls on non-primary models.
   *
   * @returns {{ switched: boolean, newModelId?: string }}
   */
  _checkRecovery() {
    // Only check if we're NOT on the primary model
    if (this.activeIndex === 0) return { switched: false };

    const primary = this.models[0];
    const current = this.models[this.activeIndex];

    // Return to primary if:
    // 1. Primary rating >= recoveryThreshold
    // 2. Primary rating >= current.rating - HYSTERESIS_RECOVERY
    if (primary.rating >= this.recoveryThreshold &&
        primary.rating >= current.rating - HYSTERESIS_RECOVERY) {
      const oldId = current.id;
      this.activeIndex = 0;

      this.rotationLog.push({
        from: oldId,
        to: primary.id,
        reason: 'primary_recovered',
        fromRating: current.rating,
        toRating: primary.rating,
        ts: Date.now()
      });

      this._usedModels.add(primary.id);

      broadcast({
        kind: 'model_rotation',
        from: oldId,
        to: primary.id,
        reason: 'primary_recovered',
        fromRating: current.rating,
        toRating: primary.rating,
        allRatings: this._getRatingsSnapshot()
      });

      broadcast({
        kind: 'log',
        level: 'info',
        text: 'Return to primary model: ' + this._shortName(primary.id) + ' (rating ' + primary.rating + '%)'
      });

      return { switched: true, newModelId: primary.id };
    }

    return { switched: false };
  }

  /**
   * Get a snapshot of all model ratings for logging.
   */
  _getRatingsSnapshot() {
    const snap = {};
    for (const m of this.models) {
      snap[m.id] = m.rating;
    }
    return snap;
  }

  /**
   * Short model name for display (strip provider prefix).
   */
  _shortName(modelId) {
    if (!modelId) return '?';
    const parts = modelId.split('/');
    return parts.length > 1 ? parts.slice(1).join('/') : modelId;
  }
}

/**
 * Helper: create a ModelRotationManager from settings.
 *
 * @param {Object} settings — full settings object
 * @returns {ModelRotationManager}
 */
export function createRotationFromSettings(settings) {
  const models = [settings.model]; // primary is always the main model

  // Add fallback models (filter out empty/duplicates)
  if (Array.isArray(settings.fallback_models)) {
    for (const fb of settings.fallback_models) {
      if (fb && fb.trim() && !models.includes(fb.trim())) {
        models.push(fb.trim());
      }
    }
  }

  return new ModelRotationManager(models, {
    switchThreshold: settings.switch_threshold ?? SWITCH_THRESHOLD_DEFAULT,
    recoveryThreshold: settings.recovery_threshold ?? RECOVERY_THRESHOLD_DEFAULT
  });
}
