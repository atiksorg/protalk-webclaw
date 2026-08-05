// agent_tab.js — Agent tab lifecycle management.
//
// Manages the target tab for agent operations: selects the user's active tab,
// attaches CDP for screenshots and trusted events, and manages URL navigation.
// Always works in "Direct Tab Mode" — the agent controls the user's tab directly.

import { runtime, sleep, broadcast } from './bus.js';
import { cdpAttach, setupNetworkIdleTracking } from './cdp.js';

// ============================================================
// AGENT TAB MANAGEMENT
// ============================================================

export async function ensureAgentTab(initialUrl) {
  // Always use the user's active tab (Direct Tab Mode)
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
    // No usable active tab — create a new one
    tab = await chrome.tabs.create({ url: initialUrl || 'about:blank', active: true });
    await sleep(500);
  } else if (initialUrl && tab.url !== initialUrl) {
    // Navigate the existing tab to the initialUrl
    await chrome.tabs.update(tab.id, { url: initialUrl });
    await sleep(500);
  }
  runtime.agentTabId = tab.id;

  broadcast({ kind: 'log', text: `[agent_tab] Using tab ${tab.id}: ${tab.url || 'new'}` });

  // Attach CDP for screenshots and trusted events
  try {
    await cdpAttach(runtime.agentTabId);
    setupNetworkIdleTracking();
  } catch (e) {
    broadcast({ kind: 'log', level: 'error', text: 'CDP attach failed: ' + e.message });
  }

  return { id: runtime.agentTabId };
}
