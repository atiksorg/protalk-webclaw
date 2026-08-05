// task_memory.js — Structured session memory for Vision-First agent.
//
// Unlike history[] (which is a rolling log of last N actions), task memory
// is a persistent, structured store that survives the entire session:
//   - User context (resume, contacts) — never trimmed
//   - Phase tracking (executing → done)
//   - Navigation tree of visited pages
//   - Scratchpad for cross-page facts
//
// Task memory is passed into the model prompt on every step,
// giving the model full context without relying on action history.

export const PHASES = {
  IDLE:       'idle',
  EXECUTING:  'executing',
  SLEEPING:   'sleeping',
  DEEP_SLEEP: 'deep_sleep',
  DONE:       'done'
};

export class TaskMemory {
  constructor() {
    this.reset();
  }

  reset() {
    this.phase = PHASES.IDLE;
    this.userContext = '';            // Resume, contacts, templates
    this.startedAt = 0;
    this.completedAt = 0;
    this.scratchpad = [];             // Scratchpad notes: persistent facts saved across pages

    // Navigation Tree — hierarchical map of visited pages
    this.navTree = [];                // Array of NavNode objects
    this.currentNodeId = null;        // ID of the currently active node
    this._nextNodeId = 1;             // Internal counter for node ID generation
  }

  // ---- Phase management ----

  setPhase(phase) {
    this.phase = phase;
    if (phase === PHASES.DONE) {
      this.completedAt = Date.now();
    }
  }

  // ---- User context ----

  setUserContext(ctx) {
    this.userContext = ctx || '';
  }

  // ---- Navigation Tree management ----

  /**
   * Create a new navigation node and add it to the tree.
   * Auto-generates an ID if not provided.
   *
   * @param {Object} node — { url, title?, nodeType?, parentId?, summary?, status? }
   * @returns {string} the node ID
   */
  addNavNode(node) {
    const id = node.id || `nav_${this._nextNodeId++}`;
    const navNode = {
      id,
      parentId: node.parentId || null,
      url: node.url || '',
      title: node.title || '',
      nodeType: node.nodeType || 'LEAF',   // 'HUB' (search results) | 'LEAF' (article, product)
      status: node.status || 'active',      // 'active' | 'explored' | 'promising' | 'dead_end'
      summary: node.summary || '',
      createdAt: Date.now()
    };
    this.navTree.push(navNode);
    this.currentNodeId = id;
    return id;
  }

  /**
   * Find a node by ID.
   * @param {string} nodeId
   * @returns {Object|null}
   */
  findNavNode(nodeId) {
    return this.navTree.find(n => n.id === nodeId) || null;
  }

  /**
   * Get the currently active node.
   * @returns {Object|null}
   */
  getCurrentNavNode() {
    return this.currentNodeId ? this.findNavNode(this.currentNodeId) : null;
  }

  /**
   * Mark a node with status and optional summary.
   * Used by the mark_node tool.
   *
   * @param {string} nodeId — target node ID (or null → current node)
   * @param {string} status — 'explored' | 'promising' | 'dead_end' | 'active'
   * @param {string} summary — brief note about what was found/learned
   * @returns {boolean} true if node was found and updated
   */
  markNavNode(nodeId, status, summary) {
    const node = this.findNavNode(nodeId || this.currentNodeId);
    if (!node) return false;
    if (status) node.status = status;
    if (summary !== undefined) node.summary = summary;
    return true;
  }

  /**
   * Jump to a node — set it as the current active node.
   * Returns the node's URL so the caller can navigate there.
   *
   * @param {string} nodeId — target node ID
   * @returns {{ ok: boolean, url?: string, error?: string }}
   */
  jumpToNavNode(nodeId) {
    const node = this.findNavNode(nodeId);
    if (!node) return { ok: false, error: `node_not_found: ${nodeId}` };
    this.currentNodeId = nodeId;
    node.status = 'active';
    return { ok: true, url: node.url };
  }

  /**
   * Get children of a node (direct descendants).
   * @param {string} parentId
   * @returns {Array}
   */
  getNavChildren(parentId) {
    return this.navTree.filter(n => n.parentId === parentId);
  }

  /**
   * Build a compact ASCII tree representation for the model prompt.
   * Shows the full tree structure with status icons and summaries.
   *
   * @returns {string} ASCII tree text
   */
  buildNavTreePrompt() {
    if (this.navTree.length === 0) return '';

    const statusIcons = {
      'active': '📍',
      'explored': '✅',
      'promising': '🔮',
      'dead_end': '❌'
    };
    const typeIcons = {
      'HUB': '🌐',
      'LEAF': '📄'
    };

    // Find root nodes (no parentId)
    const roots = this.navTree.filter(n => !n.parentId);
    if (roots.length === 0) return '';

    const lines = [];
    lines.push(`КАРТА НАВИГАЦИИ (Текущая точка: [${this.currentNodeId || 'нет'}]):`);
    lines.push('');

    const renderNode = (node, prefix, isLast) => {
      const connector = isLast ? '└── ' : '├── ';
      const statusIcon = statusIcons[node.status] || '❓';
      const typeIcon = typeIcons[node.nodeType] || '📄';
      const isCurrent = node.id === this.currentNodeId;
      const currentMarker = isCurrent ? ' ◀ ТЕКУЩАЯ СТРАНИЦА' : '';

      const summaryPart = node.summary ? `: ${node.summary.slice(0, 80)}` : '';
      const titleOrUrl = node.title || node.url.slice(0, 60);

      lines.push(`${prefix}${connector}${statusIcon} ${typeIcon} [${node.id}] ${titleOrUrl}${summaryPart}${currentMarker}`);

      // Render children
      const children = this.getNavChildren(node.id);
      children.forEach((child, i) => {
        const childPrefix = prefix + (isLast ? '    ' : '│   ');
        renderNode(child, childPrefix, i === children.length - 1);
      });
    };

    roots.forEach((root, i) => {
      const statusIcon = statusIcons[root.status] || '❓';
      const typeIcon = typeIcons[root.nodeType] || '📄';
      const isCurrent = root.id === this.currentNodeId;
      const currentMarker = isCurrent ? ' ◀ ТЕКУЩАЯ СТРАНИЦА' : '';
      const summaryPart = root.summary ? `: ${root.summary.slice(0, 80)}` : '';
      const titleOrUrl = root.title || root.url.slice(0, 60);

      lines.push(`${statusIcon} ${typeIcon} [${root.id}] ${titleOrUrl}${summaryPart}${currentMarker}`);

      const children = this.getNavChildren(root.id);
      children.forEach((child, j) => {
        renderNode(child, '', j === children.length - 1);
      });

      if (i < roots.length - 1) lines.push('');
    });

    // Add legend
    lines.push('');
    lines.push('Легенда: 📍=текущая ✅=изучена 🔮=перспективная ❌=тупик');

    return lines.join('\n');
  }

  // ---- Scratchpad management ----

  addNote(note) {
    if (!note) return;
    const noteStr = typeof note === 'string' ? note : JSON.stringify(note);
    if (!this.scratchpad.includes(noteStr)) {
      this.scratchpad.push(noteStr);
    }
  }

  addNotes(notesList) {
    if (!Array.isArray(notesList)) return;
    notesList.forEach(note => this.addNote(note));
  }

  getScratchpadText() {
    if (this.scratchpad.length === 0) return '';
    return 'AGENT\'S SCRATCHPAD (saved facts from previous pages):\n' + this.scratchpad.map(n => `- ${n}`).join('\n');
  }

  // ---- Serialize for model prompt ----

  /**
   * Build a text block that gets injected into executor/step prompts.
   * Includes navigation tree, user context, and scratchpad — everything
   * the model needs for cross-step awareness.
   */
  toPromptContext() {
    const parts = [];

    // Navigation tree (if any nodes exist)
    const navTreePrompt = this.buildNavTreePrompt();
    if (navTreePrompt) {
      parts.push(navTreePrompt);
    }

    if (this.userContext) {
      parts.push(`USER CONTEXT:\n"""\n${this.userContext}\n"""`);
    }

    // Add scratchpad notes if any
    const scratchpadText = this.getScratchpadText();
    if (scratchpadText) {
      parts.push(scratchpadText);
    }

    return parts.join('\n\n');
  }

  // ---- Summary report ----

  getReport() {
    const elapsed = this.completedAt ? this.completedAt - this.startedAt : Date.now() - this.startedAt;

    return {
      phase: this.phase,
      elapsed,
      navNodeCount: this.navTree.length,
      scratchpadCount: this.scratchpad.length
    };
  }

  // ---- Serialization for message passing (popup/status) ----

  toStatusPayload() {
    return {
      phase: this.phase,
      // Navigation tree summary
      navTree: {
        nodeCount: this.navTree.length,
        currentNodeId: this.currentNodeId,
        nodes: this.navTree.map(n => ({
          id: n.id,
          parentId: n.parentId,
          url: n.url.slice(0, 100),
          title: n.title?.slice(0, 60) || '',
          nodeType: n.nodeType,
          status: n.status,
          summary: n.summary?.slice(0, 80) || ''
        }))
      }
    };
  }
}
