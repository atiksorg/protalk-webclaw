--- START OF FILE docs/architecture.md ---
# Architecture

## Overview

WebClaw is a Chrome extension that uses AI vision to autonomously interact with websites. It runs in a dedicated background tab, captures screenshots, and executes actions based on AI decisions.

**v6.0 (WebClaw 6.0) — Vision-First & Autonomous Scheduling**: The primary mode is a single unified ReAct loop where the AI model sees ONLY the screenshot (no DOM snapshots, no CSS selectors) and returns normalized coordinates (0–1000) for all actions. Version 7.0 introduces Time-Awareness and a dual-mode Smart Sleep architecture that allows the agent to hibernate, bypassing Manifest V3 lifecycle limits while consuming zero RAM.

## Components

### 1. Popup (popup.html/js)
- User interface for task input
- Preset tasks for quick actions
- Real-time status display and AI Thought Card
- Session export functionality

### 2. Background Service Worker (background.js)
- State machine managing agent lifecycle
- API calls to AI model with exponential backoff
- **Deep Sleep Manager**: Handles `chrome.alarms` to wake the agent from hibernation
- Log fan-out to multiple UI listeners

### 3. Agent Tab (Direct Tab Mode)
- The agent controls the user's active tab directly via CDP
- No iframe, no agent.html — works on any website without X-Frame-Options/CSP issues
- CDP provides trusted mouse/keyboard events (isTrusted: true)

### 4. Content Script (content.js) & Overlay Widget
- Lightweight page info provider
- Overlay Widget: Displays real-time agent status, active phase, token usage, and AI reasoning (Thoughts)
- Sleep Panel: Visually indicates when the agent is in "Watchful" or "Deep Sleep" mode

### 5. Settings (settings.js)
- Multi-source configuration (Local > Remote Gist > Sync)
- Secure storage: `auth_token` and `api_key` are kept strictly in `chrome.storage.local`

## Data Flow

```
User Input → Popup → Background Service Worker
                         ↓
                    AI Model API (Vision Prompt + Action Log + Time)
                         ↓
                    Screenshot (CDP)
                         ↓
                    AI Decision (JSON action: tool, x, y, think)
                         ↓
                    Action Execution (CDP Trusted Events / Sleep Engine)
                         ↓
                    Observation + History Update + State Persistence
                         ↓
                    Next Iteration or Sleep
```

## Key Design Decisions

### Vision-First Architecture

#### Normalized Coordinate System
The AI model returns coordinates in a 0–1000 normalized space:
- (0, 0) = top-left of viewport
- (1000, 1000) = bottom-right of viewport
- (500, 500) = center

The runtime scales these to actual viewport pixels using the actual CDP-reported window dimensions. This eliminates DPR/zoom issues and works regardless of screen resolution.

#### Time Awareness (v7.0)
The agent prompt now continuously injects the user's local time and day of the week. This allows the LLM to make scheduling decisions autonomously (e.g., "It is 23:00, the user asked me to work only during the day. I will sleep for 32400 seconds until 08:00").

### Smart Sleep & Hibernation Engine (v7.0)

To bypass Manifest V3 service worker lifecycle limits (30s idle timeout) and save AI tokens during long waits, the agent features a dual-mode sleep system invoked via the `sleep` tool.

#### Mode A: Watchful Sleep (`wake_on_change: true`)
Used for waiting on dynamic UI events (e.g., waiting for a chat reply, progress bar completion).
- **Perceptual Hashing**: The extension pauses AI requests but keeps CDP attached. It takes a hidden screenshot every 3-5 seconds, downsamples it to a 16x16 grayscale matrix via `OffscreenCanvas`, and computes a binary perceptual hash.
- **Robustness**: This ignores sub-pixel rendering shifts and blinking cursors, but instantly detects new chat bubbles or modals.
- **Zero Token Cost**: The LLM is not called until a visual change is confirmed.

#### Mode B: Deep Sleep / Hibernation (`wake_on_change: false`)
Used for long delays (e.g., API rate limits, night shifts, scheduled runs).
- **Zero RAM / Zero CPU**: The extension completely detaches CDP, serializes the `TaskMemory` and context to `chrome.storage.session`, and sets a `chrome.alarms` trigger.
- **Unloading**: The Service Worker is allowed to die. The browser consumes 0 additional resources.
- **Rehydration**: When the alarm fires, the SW wakes up, rehydrates its state (`attemptResume`), injects the wake-up reason into the history log, and continues the task exactly where it left off.

#### Navigation Tree Memory
The agent builds a hierarchical **Navigation Tree** of all visited pages during a session, displayed to the model as an ASCII map:

```
КАРТА НАВИГАЦИИ (Текущая точка: [nav_3]):
📍 🌐 [nav_1] Google: "купить ноутбук"
├── ✅ 📄 [nav_2] dns-shop.ru/product/123: Цена 120k
└── 📍 📄 [nav_3] market.yandex.ru/product/456 ◀ ТЕКУЩАЯ СТРАНИЦА
```

**Two dedicated tools for tree management:**
- `jump_to_node(node_id)`: Teleports directly to a previously visited page via URL injection (O(1) cost instead of N `back()` calls).
- `mark_node(node_id, status, summary)`: Annotates a node (explored/promising/dead_end) and saves facts to the persistent Scratchpad.

#### Vision Tools
| Tool | Description |
|------|-------------|
| `click_at(x, y)` | CDP trusted click at normalized coords |
| `type_at(x, y, text)` | Click → Clear (Ctrl+A+Del) → Insert text via CDP |
| `press_key(key)` | CDP key press (Enter, Tab, Escape, etc.) |
| `scroll(direction, amount)` | CDP mouseWheel |
| `hover_at(x, y)` | CDP mouseMoved (triggers `:hover` CSS) |
| `select_at(x, y, value)` | CDP click + Runtime.evaluate to select `<option>` |
| `checkbox_at(x, y)` | Toggle click |
| `navigate(url)` | Tab navigation |
| `jump_to_node(node_id)` | "Teleport" to a nav tree node by ID |
| `mark_node(node_id, status)`| Annotate a nav tree node with a summary |
| `sleep(sec, wake, reason)` | Smart sleep (Watchful polling or Deep hibernation) |
| `done(answer)` | Task complete |
| `fail(reason)` | Task failed (e.g., Captcha block) |

#### Token Economy
Only the last 8 actions are sent as compact text. The model receives:
1. Current screenshot (1 image)
2. Task description + user context + **Local Time**
3. Compact action log + wake-up context (if returning from sleep)
4. Navigation Tree (ASCII) & Scratchpad

## API Integration

### ProTalk Async API
```javascript
// Create task
POST https://ai.pro-talk.ru/api/async/router
{
  "base_url": "https://openrouter.ai/api/v1/chat/completions",
  "model": "xiaomi/mimo-v2.5",
  "messages": [...],
  "stream": false
}

// Poll task
GET https://ai.pro-talk.ru/api/async/router/{taskId}
```

### Retry Logic
- Exponential backoff for 429/5xx errors
- Max 4 attempts per request
- Transient error bypass (e.g., HTTP 502)

## Security Considerations

### Permissions
- `activeTab`: Access to current tab (user-initiated)
- `tabs`: Create/manage agent tab
- `storage`: Persist settings and hibernation state
- `scripting`: Inject overlay UI
- `debugger`: CDP for screenshots and trusted events
- `alarms`: Wake from deep hibernation
- `sidePanel`: Agent monitor UI
- `downloads`: Export HTML/CURL reports

### Secret Storage
- `auth_token` and `api_key` are stored **only** in `chrome.storage.local` (device-local, never synced to Google Account)
- Remote config (Gist) is **never** allowed to import secrets

## Performance Optimizations

- **OffscreenCanvas Hashing**: Computing perceptual hashes entirely within the background worker using fast TypedArray math.
- **Zero-RAM Hibernation**: Exploiting MV3's ephemeral Service Workers as a feature rather than a bug, allowing the agent to wait hours without consuming user memory.
- **Select Probing**: Using `document.elementFromPoint` before a physical click to detect `<select>` elements and extract their options directly, bypassing the need for the AI to "see" the OS-level dropdown menu.

### Anti-Blink Architecture (v9.2)

When interacting with modern custom dropdowns (built with `<div>` instead of native `<select>`), the agent faces a timing problem: the dropdown opens beautifully, but by the time the agent waits for network idle and DOM stability to take a screenshot, the dropdown has already closed (often due to `mouseleave` events). The Anti-Blink system solves this with two complementary techniques:

#### 1. Mouse Parking
After every CDP click, the cursor is "parked" at the click coordinates with a final `mouseMoved` event. This prevents `mouseleave` events from firing on custom dropdowns/menus, keeping them open long enough for the agent to screenshot the expanded state.

```
cdpClick(x, y):
  mouseMoved(x, y) → mousePressed → mouseReleased → sleep(10ms) → mouseMoved(x, y)  // park!
```

The runtime stores the parked coordinates in `runtime._mouseParkCoords` so other modules know where the cursor is.

#### 2. Fast-Track Screenshot Mode
After UI interactions (click, hover, select, checkbox) that don't trigger navigation, the agent enters "fast-track mode" for the next screenshot. This mode skips:
- Network idle detection (analytics/ads don't matter for UI state)
- DOM stability check (mutations are expected during animations)

Instead, it only waits for:
- `document.readyState >= 'interactive'` (≤1 second)
- A small configurable delay (`fast_track_delay_ms`, default 100ms) for CSS transitions to settle

This allows the agent to "photograph" the expanded dropdown menu before it closes, typically within ~120ms of the click.

**Flow:**
```
click_at(x, y) → _fastTrackMode = true
  ↓
Next iteration: waitPageReadyFast() instead of waitPageReady()
  ↓
Screenshot captured while dropdown is still open!
  ↓
AI sees the options and can click_at the correct one
```

**Settings:**
- `fast_track_delay_ms` (default: 100ms): Delay after paint for CSS transitions to settle. Lower values capture UI faster but may miss slow animations.

## Session Logging & HTML Reports

### Overview
The agent captures a complete session log including screenshots, API calls, actions, and observations. 

1. **HTML Report** — visual timeline with persistent screenshot URLs (uploaded automatically to `file.pro-talk.ru`), collapsible API call details, and error summaries.
2. **API Log (text)** — raw CURL commands + responses for easy debugging and replay in terminal.
--- END OF FILE docs/architecture.md ---