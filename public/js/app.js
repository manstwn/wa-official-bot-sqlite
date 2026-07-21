// Active data store
let messagesList = [];
let selectedMessageId = null;
let countdownInterval = null;
let eventSource = null;
let activeTab = 'chat'; // 'chat' or 'debug'
let groupByNumber = true;
let replyLocked = false;
let systemLogsList = [];

// DOM Elements
const connStatus = document.getElementById('conn-status');
const connStatusText = connStatus.querySelector('.status-text');
const storedCount = document.getElementById('stored-count');
const feedContainer = document.getElementById('feed-container');
const feedEmpty = document.getElementById('feed-empty');
const searchInput = document.getElementById('search-input');
const typeFilter = document.getElementById('type-filter');

// Tab Switcher Elements
const tabBtnChat = document.getElementById('tab-btn-chat');
const tabBtnDebug = document.getElementById('tab-btn-debug');
const tabPaneChat = document.getElementById('tab-pane-chat');
const tabPaneDebug = document.getElementById('tab-pane-debug');

// Tab 1: Chat View Elements
const detailSenderChat = document.getElementById('detail-sender-chat');
const chatMessagesContainer = document.getElementById('chat-messages-container');
const chatReplyForm = document.getElementById('chat-reply-form');
const chatReplyInput = document.getElementById('chat-reply-input');
const btnDebugPost = document.getElementById('btn-debug-post');
const chatFooter = document.getElementById('chat-footer');
const replyLockBanner = document.getElementById('reply-lock-banner');
const replyLockIndicator = document.getElementById('reply-lock-indicator');
const replyTimeLeft = document.getElementById('reply-time-left');

// Tab 2: Debug Panel Elements
const detailEmpty = document.getElementById('detail-empty');
const detailContent = document.getElementById('detail-content');
const detailTypeBadge = document.getElementById('detail-type-badge');
const detailTime = document.getElementById('detail-time');
const detailSender = document.getElementById('detail-sender');
const detailMsgId = document.getElementById('detail-msg-id');
const detailBodyText = document.getElementById('detail-body-text');
const detailMediaSection = document.getElementById('detail-media-section');
const detailImagePreviewBox = document.getElementById('detail-image-preview-box');
const detailImagePreview = document.getElementById('detail-image-preview');
const detailTempUrl = document.getElementById('detail-temp-url');
const detailDownloadLink = document.getElementById('detail-download-link');
const countdownBadge = document.getElementById('countdown-badge');
const countdownTimer = document.getElementById('countdown-timer');
const detailJsonCode = document.getElementById('detail-json-code');

// Action Buttons
const btnClear = document.getElementById('btn-clear');
const btnCopyId = document.getElementById('btn-copy-id');
const btnCopyJson = document.getElementById('btn-copy-json');
const btnToggleGroup = document.getElementById('btn-toggle-group');

// Outgoing Debug Modal Elements
const outgoingDebugModal = document.getElementById('outgoing-debug-modal');
const btnCloseOutgoingModal = document.getElementById('btn-close-outgoing-modal');
const btnCloseOutgoingModalOverlay = document.getElementById('btn-close-outgoing-modal-overlay');
const btnCloseOutgoingModalFooter = document.getElementById('btn-close-outgoing-modal-footer');
const btnCopyOutgoingJson = document.getElementById('btn-copy-outgoing-json');
const outgoingJsonCode = document.getElementById('outgoing-json-code');

// Maintenance Toggle
const maintenanceCheckbox = document.getElementById('maintenance-checkbox');

/* ==========================================================================
   INITIALIZATION & API CALLS
   ========================================================================== */
document.addEventListener('DOMContentLoaded', async () => {
  // 0. Check authentication
  const token = sessionStorage.getItem('wa_token');
  if (token) {
    try {
      const res = await fetch('/api/auth/check?token=' + encodeURIComponent(token));
      const data = await res.json();
      if (!data.valid) {
        sessionStorage.removeItem('wa_token');
        window.location.href = '/admin/login.html';
        return;
      }
    } catch {
      window.location.href = '/admin/login.html';
      return;
    }
  } else {
    window.location.href = '/admin/login.html';
    return;
  }

  // 1. Fetch initial records
  fetchMessages();
  fetchSystemLogs();

  // 2. Open real-time SSE stream
  connectSSE();

  // 3. Load Maintenance toggle state
  fetchMaintenanceToggle();

  // 4. Bind UI interactions
  setupEventListeners();

  // 5. Apply default ON state for group-by toggle
  btnToggleGroup.style.background = 'var(--color-brand)';
  btnToggleGroup.style.color = 'white';
  btnToggleGroup.style.borderColor = 'var(--color-brand)';
  btnToggleGroup.style.boxShadow = '0 0 10px var(--color-brand-glow)';
  btnToggleGroup.title = 'Show Raw Payload Stream';

  // Initialize Lucide Icons
  lucide.createIcons();
});

// Fetch messages from Express REST endpoint
async function fetchMessages() {
  try {
    const res = await fetch('/api/messages');
    if (!res.ok) throw new Error('Failed to fetch messages');
    const messages = await res.json();
    messagesList = messages;
    updateStats();
    renderFeed();
  } catch (error) {
    console.error('Error fetching initial messages:', error);
  }
}

// Clear messages database
async function clearLogs() {
  if (!confirm('Apakah Anda yakin ingin menghapus semua riwayat data webhook? Tindakan ini tidak dapat dibatalkan.')) {
    return;
  }

  try {
    const res = await fetch('/api/messages', { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to clear messages');

    messagesList = [];
    selectedMessageId = null;
    updateStats();
    renderFeed();
    resetDetailPanel();
  } catch (error) {
    console.error('Error clearing messages:', error);
  }
}

// Fetch Maintenance toggle state from server
async function fetchMaintenanceToggle() {
  try {
    const res = await fetch('/api/auto-ai/toggle');
    if (!res.ok) throw new Error('Failed to fetch toggle');
    const data = await res.json();
    if (data.success) {
      // Inverted logic: Maintenance is active (checked) if autoAiEnabled is false (not enabled)
      maintenanceCheckbox.checked = !data.enabled;
      updateAiActiveIndicator();
    }
  } catch (error) {
    console.error('Error fetching Maintenance toggle:', error);
  }
}

// Save Maintenance toggle state to server
async function saveMaintenanceToggle(active) {
  try {
    // Inverted logic: if Maintenance is checked (active=true), we set enabled to false
    const enabled = !active;
    const res = await fetch('/api/auto-ai/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    if (!res.ok) throw new Error('Failed to save toggle');
    console.log(`[Maintenance] Mode set to ${active ? 'ON (Replies disabled)' : 'OFF (Replies enabled)'}`);
    updateAiActiveIndicator();
  } catch (error) {
    console.error('Error saving Maintenance toggle:', error);
    // Revert checkbox on failure
    maintenanceCheckbox.checked = !active;
    updateAiActiveIndicator();
  }
}



/* ==========================================================================
   SSE REAL-TIME STREAMING
   ========================================================================== */
function connectSSE() {
  setConnectionStatus('connecting');

  // Create EventSource
  eventSource = new EventSource('/api/stream');

  eventSource.onopen = () => {
    setConnectionStatus('connected');
  };

  eventSource.onerror = (err) => {
    console.error('SSE Error:', err);
    setConnectionStatus('disconnected');
    // Attempt reconnection after 5 seconds
    eventSource.close();
    setTimeout(connectSSE, 5000);
  };

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      // Handle system events
      if (data.type === 'SYSTEM_CONNECTED') {
        console.log(`[SSE] Handshake complete. Active connections: ${data.activeClients}`);
        return;
      }

      if (data.type === 'SYSTEM_CLEAR') {
        messagesList = [];
        systemLogsList = [];
        selectedMessageId = null;
        updateStats();
        renderFeed();
        renderSystemLogs();
        resetDetailPanel();
        return;
      }

      if (data.type === 'SYSTEM_LOG') {
        systemLogsList.unshift(data.log);
        if (systemLogsList.length > 100) systemLogsList.pop();
        renderSystemLogs();
        return;
      }

      if (data.type === 'SYSTEM_LOGS_CLEAR') {
        systemLogsList = [];
        renderSystemLogs();
        return;
      }

      // Handle normal webhook insertion (check if already exists to update media path)
      const selectedMsg = messagesList.find(m => m.id === selectedMessageId);
      const activeContact = selectedMsg ? ((selectedMsg.from === 'system' || !selectedMsg.from) ? selectedMsg.to : selectedMsg.from) : null;

      const existingIdx = messagesList.findIndex(m => m.id === data.id);
      if (existingIdx !== -1) {
        messagesList[existingIdx] = data;
        // If the updated message is currently selected, refresh details
        if (selectedMessageId === data.id) {
          selectMessage(data.id);
        }
      } else {
        messagesList.unshift(data); // Add to local state list
      }

      // If this message belongs to the active contact conversation, refresh bubbles
      const incomingContact = (data.from === 'system' || !data.from) ? data.to : data.from;
      if (activeContact && incomingContact === activeContact) {
        renderChatThread(activeContact, true);
      }

      updateStats();
      renderFeed();

      // Trigger subtle pulse on brand logo or header to indicate incoming payload
      pulseHeader();

    } catch (e) {
      console.error('Error parsing SSE event data:', e);
    }
  };
}

function setConnectionStatus(status) {
  connStatus.className = 'status-badge';
  if (status === 'connected') {
    connStatus.classList.add('connected');
    connStatusText.textContent = 'Live Connected';
  } else if (status === 'connecting') {
    connStatus.classList.add('disconnected');
    connStatusText.textContent = 'Connecting...';
  } else {
    connStatus.classList.add('disconnected');
    connStatusText.textContent = 'Disconnected';
  }
}

function updateStats() {
  storedCount.textContent = messagesList.length;
}

function pulseHeader() {
  const logo = document.querySelector('.logo-icon');
  logo.style.transform = 'scale(1.1)';
  logo.style.transition = 'transform 0.15s ease';
  setTimeout(() => {
    logo.style.transform = 'scale(1)';
  }, 150);
}

/* ==========================================================================
   FEED RENDER & FILTERING
   ========================================================================== */
function getFilteredMessages() {
  const query = searchInput.value.toLowerCase().trim();
  const filterType = typeFilter.value;

  // 1. First, apply filter & search
  let filtered = messagesList.filter(msg => {
    // Filter by Message Type
    if (filterType !== 'all') {
      if (filterType === 'other') {
        if (msg.type === 'text' || msg.type === 'image' || msg.type === 'audio') {
          return false;
        }
      } else if (msg.type !== filterType) {
        return false;
      }
    }

    // Filter by Search Query
    if (query) {
      const contactNumber = (msg.from === 'system' || !msg.from) ? msg.to : msg.from;
      const matchNumber = contactNumber && contactNumber.includes(query);
      const matchBody = msg.body && msg.body.toLowerCase().includes(query);
      const matchId = msg.id && msg.id.toLowerCase().includes(query);
      return matchNumber || matchBody || matchId;
    }

    return true;
  });

  const totalBeforeLimit = filtered.length;
  // 2. If groupByNumber is active, aggregate by unique contact number (showing the latest message of each)
  if (groupByNumber) {
    const contactMap = new Map();
    filtered.forEach(msg => {
      const contactNumber = (msg.from === 'system' || !msg.from) ? msg.to : msg.from;
      if (!contactNumber) return;
      if (!contactMap.has(contactNumber)) {
        contactMap.set(contactNumber, msg);
      } else {
        const existing = contactMap.get(contactNumber);
        if (msg.timestamp > existing.timestamp) {
          contactMap.set(contactNumber, msg);
        }
      }
    });
    filtered = Array.from(contactMap.values());
    // Sort descending by timestamp so latest chats are at the top
    filtered.sort((a, b) => b.timestamp - a.timestamp);
  } else {
    // In ungrouped mode, cap at 100 to keep the list manageable
    if (filtered.length > 100) {
      filtered = filtered.slice(0, 100);
    }
  }

  return { items: filtered, totalBeforeLimit };
}

function renderFeed() {
  const { items: filtered, totalBeforeLimit } = getFilteredMessages();

  // Remove old items + any "older messages" indicator
  const existing = feedContainer.querySelectorAll('.feed-item, .feed-older-indicator');
  existing.forEach(el => el.remove());

  if (filtered.length === 0) {
    feedEmpty.classList.remove('hidden');
    return;
  }

  feedEmpty.classList.add('hidden');

  filtered.forEach(msg => {
    const item = document.createElement('div');
    const isOutbound = msg.direction === 'outbound' || msg.from === 'system';
    item.className = `feed-item type-${msg.type || 'other'}${isOutbound ? ' outbound' : ''}`;

    const contactNumber = (msg.from === 'system' || !msg.from) ? msg.to : msg.from;

    // Highlight active selection
    if (groupByNumber) {
      const selectedMsg = messagesList.find(m => m.id === selectedMessageId);
      if (selectedMsg) {
        const selectedContact = (selectedMsg.from === 'system' || !selectedMsg.from) ? selectedMsg.to : selectedMsg.from;
        if (selectedContact === contactNumber) {
          item.classList.add('active');
        }
      }
    } else {
      if (msg.id === selectedMessageId) {
        item.classList.add('active');
      }
    }

    const dirIcon = isOutbound ? 'arrow-up-right' : 'arrow-down-right';
    const displaySender = (isOutbound && !groupByNumber) ? `You to +${contactNumber}` : (contactNumber ? `+${contactNumber}` : 'Unknown');
    const previewLabel = msg.body || (msg.type === 'image' ? 'Image' : msg.type === 'audio' ? 'Audio' : 'Media');

    const senderLabel = isOutbound ? 'You' : (contactNumber ? `+${contactNumber}` : 'Unknown');
    item.innerHTML = `
      <div class="feed-avatar ${isOutbound ? 'dir-out' : 'dir-in'}">
        <i data-lucide="${dirIcon}"></i>
      </div>
      <div class="feed-content">
        <div class="feed-content-top">
          <span class="feed-contact">${escapeHtml(displaySender)}</span>
          <span class="feed-badge badge-${msg.type || 'other'}">${msg.type || 'other'}</span>
          <span class="feed-time">${timeAgo(msg.timestamp * 1000)}</span>
        </div>
        <div class="feed-content-body">
          <span class="feed-sender-label">${escapeHtml(senderLabel)}</span>
          <span class="feed-sender-colon">:</span>
          <span>${escapeHtml(previewLabel)}</span>
        </div>
      </div>
    `;

    item.addEventListener('click', () => {
      selectMessage(msg.id);
    });

    feedContainer.appendChild(item);
  });

  // Show "X older messages" indicator if items were truncated in ungrouped mode
  if (!groupByNumber && totalBeforeLimit > filtered.length) {
    const older = document.createElement('div');
    older.className = 'feed-older-indicator';
    older.textContent = `+ ${totalBeforeLimit - filtered.length} older messages`;
    feedContainer.appendChild(older);
  }

  // Reinitialize icons in injected components
  lucide.createIcons();
}

function formatTime(timestampMs) {
  const date = new Date(timestampMs);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function timeAgo(timestampMs) {
  const seconds = Math.floor((Date.now() - timestampMs) / 1000);
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatTime(timestampMs);
}

/* ==========================================================================
   DETAIL VIEW & COUNTDOWN TIMER
   ========================================================================== */
function selectMessage(msgId) {
  selectedMessageId = msgId;

  // Highlight active item in feed list
  const items = feedContainer.querySelectorAll('.feed-item');
  items.forEach(el => el.classList.remove('active'));

  // Find standard data record
  const msg = messagesList.find(m => m.id === msgId);
  if (!msg) return;

  // Re-render feed to apply active classes
  renderFeed();

  // Display detail panel
  detailEmpty.classList.add('hidden');
  detailContent.classList.remove('hidden');

  // 1. Populate Tab 1: Chat View
  const contactNumber = (msg.from === 'system' || !msg.from) ? msg.to : msg.from;
  detailSenderChat.textContent = contactNumber ? `+${contactNumber}` : 'Unknown Contact';
  renderChatThread(contactNumber);
  updateReplyLock(contactNumber);

  // 2. Populate Tab 2: Original Debug View
  detailTypeBadge.textContent = msg.type ? msg.type.toUpperCase() : 'OTHER';
  detailTypeBadge.className = `detail-type-badge badge-${msg.type || 'other'}`;

  const fullDate = new Date(msg.timestamp * 1000);
  detailTime.textContent = fullDate.toLocaleString();

  detailSender.textContent = msg.from ? `+${msg.from}` : 'Unknown Sender';
  detailMsgId.textContent = msg.id || 'N/A';
  detailBodyText.innerHTML = msg.body ? escapeHtml(msg.body).replace(/\n/g, '<br>') : '<em class="text-muted">No text content or caption.</em>';

  // Media handling
  if (msg.tempMediaUrl) {
    detailMediaSection.classList.remove('hidden');
    detailTempUrl.value = msg.tempMediaUrl;
    detailDownloadLink.href = msg.tempMediaUrl;

    // Image visual preview
    if (msg.type === 'image') {
      detailImagePreviewBox.classList.remove('hidden');
      detailImagePreview.src = msg.tempMediaUrl;
    } else {
      detailImagePreviewBox.classList.add('hidden');
      detailImagePreview.src = '';
    }

    // Start temporary link countdown (10 minutes = 600 seconds)
    startCountdown(msg.timestamp);
  } else {
    detailMediaSection.classList.add('hidden');
    detailImagePreviewBox.classList.add('hidden');
    detailImagePreview.src = '';
    stopCountdown();
  }

  // Render syntax-highlighted raw JSON
  detailJsonCode.innerHTML = syntaxHighlightJson(msg.rawData || msg);
  const detailResponseCode = document.getElementById('detail-response-code');
  if (detailResponseCode) {
    detailResponseCode.innerHTML = syntaxHighlightJson(msg.metaResponse || msg);
  }

  // Refresh detail icons
  lucide.createIcons();
}

function resetDetailPanel() {
  detailContent.classList.add('hidden');
  detailEmpty.classList.remove('hidden');
  stopCountdown();
}

function startCountdown(msgTimestampSeconds) {
  stopCountdown();

  const expiryTimeSeconds = msgTimestampSeconds + 600; // 10 minutes limit

  function updateTimer() {
    const currentSeconds = Math.floor(Date.now() / 1000);
    const remainingSeconds = expiryTimeSeconds - currentSeconds;

    if (remainingSeconds <= 0) {
      countdownTimer.textContent = 'Expired';
      countdownBadge.className = 'countdown-badge expired';
      detailDownloadLink.classList.add('btn-secondary');
      detailDownloadLink.classList.remove('btn-primary');
      detailDownloadLink.setAttribute('disabled', 'true');
      detailDownloadLink.style.pointerEvents = 'none';
      detailDownloadLink.innerHTML = '<i data-lucide="lock"></i> Link Expired';
      lucide.createIcons();
      clearInterval(countdownInterval);
      return;
    }

    const minutes = Math.floor(remainingSeconds / 60);
    const seconds = remainingSeconds % 60;

    countdownTimer.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    countdownBadge.className = 'countdown-badge';
    detailDownloadLink.classList.remove('btn-secondary');
    detailDownloadLink.classList.add('btn-primary');
    detailDownloadLink.removeAttribute('disabled');
    detailDownloadLink.style.pointerEvents = 'auto';
    detailDownloadLink.innerHTML = '<i data-lucide="external-link"></i> Open';
    lucide.createIcons();
  }

  updateTimer(); // Tick immediately
  countdownInterval = setInterval(updateTimer, 1000);
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

/* ==========================================================================
   CHAT THREAD RENDERING
   ========================================================================== */
function renderChatThread(contactNumber, forceScrollToBottom = false) {
  if (!contactNumber) return;

  // Filter messages for this contact (either sent by them or sent to them)
  const filtered = messagesList.filter(msg => {
    const isFrom = msg.from === contactNumber;
    const isTo = msg.to === contactNumber;
    return isFrom || isTo;
  });

  // Sort chronologically (oldest at the top, newest at the bottom)
  const thread = [...filtered].sort((a, b) => a.timestamp - b.timestamp);

  // Clear chat thread container
  chatMessagesContainer.innerHTML = '';

  if (thread.length === 0) {
    chatMessagesContainer.innerHTML = `
      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: var(--text-muted); font-size: 0.8rem;">
        <p>No messages in this conversation thread.</p>
      </div>
    `;
    return;
  }

  thread.forEach(msg => {
    const bubble = document.createElement('div');
    const isOutbound = msg.direction === 'outbound' || msg.from === 'system';
    bubble.className = `chat-bubble ${isOutbound ? 'bubble-outgoing' : 'bubble-incoming'}`;
    bubble.dataset.msgId = msg.id;

    // Bubble inner contents
    let mediaContent = '';
    if (msg.type === 'image' && msg.tempMediaUrl) {
      mediaContent = `
        <div class="bubble-image-preview">
          <img src="${msg.tempMediaUrl}" alt="Media Preview" />
        </div>
      `;
    } else if (msg.type === 'audio' && msg.tempMediaUrl) {
      mediaContent = `
        <audio src="${msg.tempMediaUrl}" controls style="max-width: 100%; margin-top: 4px; filter: invert(0.9); height: 32px;"></audio>
      `;
    }

    const timeFormatted = formatTime(msg.timestamp * 1000);

    // Outbound shows blue double checks, inbound shows nothing
    const checkmarks = isOutbound
      ? '<i data-lucide="check-check" style="color: #4fc3f7; width: 14px; height: 14px; margin-left: 2px;"></i>'
      : '';

    const bodyEscaped = msg.body ? escapeHtml(msg.body).replace(/\n/g, '<br>') : '';

    bubble.innerHTML = `
      ${mediaContent}
      ${bodyEscaped ? `<div class="bubble-text">${bodyEscaped}</div>` : ''}
      <div class="bubble-meta">
        <span>${timeFormatted}</span>
        ${checkmarks}
      </div>
    `;

    chatMessagesContainer.appendChild(bubble);
  });

  // Scroll handling: scroll to highlighted message, or to bottom
  let scrolled = false;
  if (selectedMessageId && !forceScrollToBottom) {
    const targetBubble = chatMessagesContainer.querySelector(`[data-msg-id="${selectedMessageId}"]`);
    if (targetBubble) {
      targetBubble.scrollIntoView({ block: 'center', behavior: 'smooth' });
      targetBubble.classList.add('bubble-highlight');
      setTimeout(() => targetBubble.classList.remove('bubble-highlight'), 2000);
      scrolled = true;
    }
  }

  if (!scrolled || forceScrollToBottom) {
    chatMessagesContainer.scrollTop = chatMessagesContainer.scrollHeight;
  }

  // Render Lucide Icons inside bubbles
  lucide.createIcons();
}

/* ==========================================================================
   UI UTILITIES & INTERACTION
   ========================================================================== */
function setupEventListeners() {
  // Logout / Lock
  document.getElementById('btn-logout').addEventListener('click', () => {
    sessionStorage.removeItem('wa_token');
    window.location.href = '/admin/login.html';
  });

  // Clear Logs
  btnClear.addEventListener('click', clearLogs);

  // Search & Filter
  searchInput.addEventListener('input', renderFeed);
  typeFilter.addEventListener('change', renderFeed);

  // Maintenance Toggle
  maintenanceCheckbox.addEventListener('change', () => {
    saveMaintenanceToggle(maintenanceCheckbox.checked);
    updateAiActiveIndicator();
  });



  // Group by Number Toggle
  btnToggleGroup.addEventListener('click', () => {
    groupByNumber = !groupByNumber;
    if (groupByNumber) {
      btnToggleGroup.style.background = 'var(--color-brand)';
      btnToggleGroup.style.color = 'white';
      btnToggleGroup.style.borderColor = 'var(--color-brand)';
      btnToggleGroup.style.boxShadow = '0 0 10px var(--color-brand-glow)';
      btnToggleGroup.title = "Show Raw Payload Stream";
    } else {
      btnToggleGroup.style.background = 'rgba(255,255,255,0.02)';
      btnToggleGroup.style.color = 'var(--text-muted)';
      btnToggleGroup.style.borderColor = 'var(--border-color)';
      btnToggleGroup.style.boxShadow = 'none';
      btnToggleGroup.title = "Group by Phone Number";
    }
    renderFeed();
  });

  // Tabs Switcher
  tabBtnChat.addEventListener('click', () => switchTab('chat'));
  tabBtnDebug.addEventListener('click', () => switchTab('debug'));

  // Chat Reply Form
  chatReplyForm.addEventListener('submit', sendReply);

  // Debug Post Modal Triggers
  btnDebugPost.addEventListener('click', openOutgoingDebugModal);
  btnCloseOutgoingModal.addEventListener('click', closeOutgoingDebugModal);
  btnCloseOutgoingModalOverlay.addEventListener('click', closeOutgoingDebugModal);
  btnCloseOutgoingModalFooter.addEventListener('click', closeOutgoingDebugModal);

  // Copy Outgoing API Payload JSON
  btnCopyOutgoingJson.addEventListener('click', () => {
    const text = outgoingJsonCode.textContent;
    copyToClipboard(text, btnCopyOutgoingJson);
  });

  // Copy Buttons (Original Debug Pane)
  btnCopyId.addEventListener('click', () => {
    const msg = messagesList.find(m => m.id === selectedMessageId);
    if (msg && msg.id) {
      copyToClipboard(msg.id, btnCopyId);
    }
  });

  btnCopyJson.addEventListener('click', () => {
    const msg = messagesList.find(m => m.id === selectedMessageId);
    if (msg) {
      copyToClipboard(JSON.stringify(msg.rawData || msg, null, 2), btnCopyJson);
    }
  });

  const btnCopyResponseJson = document.getElementById('btn-copy-response-json');
  if (btnCopyResponseJson) {
    btnCopyResponseJson.addEventListener('click', () => {
      const msg = messagesList.find(m => m.id === selectedMessageId);
      if (msg) {
        copyToClipboard(JSON.stringify(msg.metaResponse || msg, null, 2), btnCopyResponseJson);
      }
    });
  }

  // Left Panel Tabs
  const tabBtnPayloads = document.getElementById('tab-btn-payloads');
  const tabBtnLogs = document.getElementById('tab-btn-logs');
  const paneLeftPayloads = document.getElementById('pane-left-payloads');
  const paneLeftLogs = document.getElementById('pane-left-logs');

  if (tabBtnPayloads && tabBtnLogs) {
    tabBtnPayloads.addEventListener('click', () => {
      tabBtnPayloads.classList.add('active');
      tabBtnLogs.classList.remove('active');
      paneLeftPayloads.style.display = 'flex';
      paneLeftLogs.style.display = 'none';
    });

    tabBtnLogs.addEventListener('click', () => {
      tabBtnLogs.classList.add('active');
      tabBtnPayloads.classList.remove('active');
      paneLeftPayloads.style.display = 'none';
      paneLeftLogs.style.display = 'flex';
      if (typeof lucide !== 'undefined') lucide.createIcons();
    });
  }

  // Clear System Logs button
  const btnClearSysLogs = document.getElementById('btn-clear-sys-logs');
  if (btnClearSysLogs) {
    btnClearSysLogs.addEventListener('click', async () => {
      if (!confirm('Apakah Anda yakin ingin menghapus semua riwayat log aktivitas bot?')) return;
      try {
        const res = await fetch('/api/system-logs', { method: 'DELETE' });
        if (!res.ok) throw new Error('Failed to clear system logs');
        systemLogsList = [];
        renderSystemLogs();
      } catch (err) {
        console.error('Error clearing system logs:', err);
      }
    });
  }
}

// Tab switcher handler
function switchTab(tabName) {
  activeTab = tabName;
  if (tabName === 'chat') {
    tabBtnChat.classList.add('active');
    tabBtnDebug.classList.remove('active');
    tabPaneChat.classList.add('active');
    tabPaneDebug.classList.remove('active');
    // Scroll chat thread to bottom
    chatMessagesContainer.scrollTop = chatMessagesContainer.scrollHeight;
  } else {
    tabBtnChat.classList.remove('active');
    tabBtnDebug.classList.add('active');
    tabPaneChat.classList.remove('active');
    tabPaneDebug.classList.add('active');
  }
}

// Format seconds into human readable
function formatTimeLeft(seconds) {
  if (seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}

// Update reply footer lock state based on last contact message age
function updateReplyLock(contactNumber) {
  if (!contactNumber) return;

  // Find the latest message FROM the contact (not system/outbound)
  const inboundMsgs = messagesList.filter(m => m.from === contactNumber);
  let latestInbound = null;
  inboundMsgs.forEach(m => {
    if (!latestInbound || m.timestamp > latestInbound.timestamp) {
      latestInbound = m;
    }
  });

  const twelveHours = 12 * 60 * 60; // 12 hours in seconds
  const now = Math.floor(Date.now() / 1000);
  const age = latestInbound ? (now - latestInbound.timestamp) : twelveHours + 1;
  const shouldLock = age > twelveHours;

  replyLocked = shouldLock;

  if (shouldLock) {
    chatFooter.classList.add('locked');
    replyLockBanner.classList.remove('hidden');
    replyLockIndicator.innerHTML = '<i data-lucide="lock"></i>';
    chatReplyInput.disabled = true;
    chatReplyInput.placeholder = 'Reply locked — last message over 12h ago';
    replyTimeLeft.textContent = '';
  } else {
    chatFooter.classList.remove('locked');
    replyLockBanner.classList.add('hidden');
    replyLockIndicator.innerHTML = '<i data-lucide="lock-open"></i>';
    chatReplyInput.disabled = false;
    chatReplyInput.placeholder = 'Type a reply...';
    replyTimeLeft.textContent = formatTimeLeft(twelveHours - age);
  }

  // Rebuild lucide icons since we changed icon attributes
  if (typeof lucide !== 'undefined') {
    lucide.createIcons();
  }
}

// Send simulated reply
async function sendReply(event) {
  event.preventDefault();
  if (replyLocked) return;
  const text = chatReplyInput.value.trim();
  if (!text || !selectedMessageId) return;

  // Get active contact number from the selected message
  const msg = messagesList.find(m => m.id === selectedMessageId);
  if (!msg) return;
  const contactNumber = (msg.from === 'system' || !msg.from) ? msg.to : msg.from;

  chatReplyInput.value = '';

  try {
    const res = await fetch('/api/messages/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: contactNumber,
        body: text
      })
    });
    if (!res.ok) throw new Error('Failed to dispatch reply');
    console.log('[Chat] Reply dispatched successfully.');
  } catch (error) {
    console.error('Error sending reply:', error);
    alert('Failed to send reply: ' + error.message);
  }
}

// Open outgoing post payload debugger modal
function openOutgoingDebugModal() {
  const replyText = chatReplyInput.value.trim() || "Type a reply message in the input field first to inspect outgoing payload...";

  // Retrieve sender number
  const msg = messagesList.find(m => m.id === selectedMessageId);
  const targetContact = msg ? ((msg.from === 'system' || !msg.from) ? msg.to : msg.from) : "6289643180966";

  const outgoingPayload = {
    messaging_product: "whatsapp",
    to: targetContact,
    type: "text",
    text: {
      body: replyText
    }
  };

  outgoingJsonCode.innerHTML = syntaxHighlightJson(outgoingPayload);
  outgoingDebugModal.classList.add('open');
  lucide.createIcons();
}

function closeOutgoingDebugModal() {
  outgoingDebugModal.classList.remove('open');
}

// Helper to escape HTML characters
function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return text.replace(/[&<>"']/g, m => map[m]);
}

// Copy text utility with brief success visual effect
async function copyToClipboard(text, triggerButton) {
  try {
    await navigator.clipboard.writeText(text);

    // Visual indicator
    const originalHTML = triggerButton.innerHTML;
    triggerButton.innerHTML = '<i data-lucide="check" style="color: #4ade80;"></i>';
    lucide.createIcons();

    setTimeout(() => {
      triggerButton.innerHTML = originalHTML;
      lucide.createIcons();
    }, 1500);
  } catch (err) {
    console.error('Failed to copy text:', err);
  }
}

// Pretty print JSON inside raw display
function syntaxHighlightJson(jsonObj) {
  let json = JSON.stringify(jsonObj, null, 2);
  json = escapeHtml(json);

  return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g, function (match) {
    let cls = 'json-number';
    if (/^"/.test(match)) {
      if (/:$/.test(match)) {
        cls = 'json-key';
      } else {
        cls = 'json-value';
      }
    } else if (/true|false/.test(match)) {
      cls = 'json-boolean';
    } else if (/null/.test(match)) {
      cls = 'json-null';
    }
    return '<span class="' + cls + '">' + match + '</span>';
  });
}


// ============================================================
// Landing Page Button — load URL from server env
// ============================================================
(async function initLandingBtn() {
  try {
    const btn = document.getElementById('btn-landing');
    if (btn) {
      btn.href = '/';
      btn.style.display = 'flex';
    }
  } catch (e) {
    // silently ignore — button stays hidden
  }
})();

function updateAiActiveIndicator() {
  const indicator = document.getElementById('ai-active-indicator');
  if (!indicator) return;

  const isMaintenance = maintenanceCheckbox && maintenanceCheckbox.checked;

  if (isMaintenance) {
    indicator.textContent = '--- Mode Maintenance aktif, AI akan membalas sedang maintenance ---';
    indicator.style.color = '#f59e0b';
    indicator.style.display = 'inline-flex';
  } else {
    indicator.textContent = '--- Mode AI diaktifkan (Hanya Gambar), AI akan memproses gambar secara otomatis ---';
    indicator.style.color = '#10b981';
    indicator.style.display = 'inline-flex';
  }
}

// ============================================================
// Bot Activity Logs
// ============================================================
async function fetchSystemLogs() {
  try {
    const res = await fetch('/api/system-logs');
    if (!res.ok) throw new Error('Failed to fetch system logs');
    systemLogsList = await res.json();
    renderSystemLogs();
  } catch (error) {
    console.error('Error fetching system logs:', error);
  }
}

function renderSystemLogs() {
  const container = document.getElementById('sys-logs-container');
  const emptyState = document.getElementById('sys-logs-empty');
  if (!container) return;

  container.innerHTML = '';

  if (systemLogsList.length === 0) {
    if (emptyState) {
      emptyState.style.display = 'block';
      container.appendChild(emptyState);
    } else {
      container.appendChild(createLogsEmptyState());
    }
    return;
  }

  if (emptyState) emptyState.style.display = 'none';

  systemLogsList.forEach(log => {
    const logEl = document.createElement('div');
    logEl.className = `log-item log-level-${log.level}`;
    logEl.style.padding = '8px 10px';
    logEl.style.borderRadius = '6px';
    logEl.style.marginBottom = '6px';
    logEl.style.lineHeight = '1.4';
    logEl.style.wordBreak = 'break-all';

    let bg = 'var(--bg-secondary)';
    let color = 'var(--text-primary)';
    let border = '1px solid var(--border-color)';
    let prefix = 'info';

    if (log.level === 'error') {
      bg = 'var(--status-disconnected-bg)';
      color = 'var(--status-disconnected-text)';
      border = '1px solid var(--status-disconnected-bg)';
      prefix = 'error';
    } else if (log.level === 'warn') {
      bg = 'rgba(217, 119, 6, 0.08)';
      color = 'var(--color-audio-msg)';
      border = '1px solid rgba(217, 119, 6, 0.15)';
      prefix = 'warn';
    } else if (log.level === 'info') {
      bg = 'var(--status-connected-bg)';
      color = 'var(--status-connected-text)';
      border = '1px solid var(--status-connected-bg)';
      prefix = 'info';
    }

    logEl.style.background = bg;
    logEl.style.color = color;
    logEl.style.border = border;

    const timeStr = new Date(log.timestamp).toLocaleTimeString();
    logEl.innerHTML = `<span style="color:var(--text-muted);margin-right:8px;">[${timeStr}]</span> <strong style="text-transform: uppercase; font-size: 0.65rem; border: 1px solid currentColor; padding: 1px 4px; border-radius: 4px; margin-right: 6px;">${prefix}</strong> <span style="color:var(--text-primary);">${escapeHtml(log.message)}</span>`;
    container.appendChild(logEl);
  });
}

function createLogsEmptyState() {
  const div = document.createElement('div');
  div.id = 'sys-logs-empty';
  div.style.color = 'var(--text-muted)';
  div.style.textAlign = 'center';
  div.style.marginTop = '40px';
  div.innerHTML = `
    <i data-lucide="terminal" style="width:24px;height:24px;margin-bottom:8px;color:var(--text-muted);"></i>
    <p>Belum ada aktivitas bot yang tercatat.</p>
  `;
  return div;
}

// ============================================================
// AI Config Modal
// ============================================================
(function initAIConfigModal() {
  const modal = document.getElementById('ai-config-modal');
  const btnOpen = document.getElementById('btn-ai-config');
  const btnClose = document.getElementById('btn-close-ai-config');
  const btnCancel = document.getElementById('btn-ai-config-cancel');
  const btnSave = document.getElementById('btn-ai-config-save');
  const overlay = document.getElementById('ai-config-modal-overlay');
  const saveStatus = document.getElementById('cfg-save-status');

  const groupGemini = document.getElementById('cfg-group-gemini');
  const groupOR = document.getElementById('cfg-group-openrouter');
  const inputGemModel = document.getElementById('cfg-gemini-model');
  const inputOrModel = document.getElementById('cfg-or-model');
  const inputGemKey = document.getElementById('cfg-gemini-key');
  const inputOrKey = document.getElementById('cfg-or-key');
  const inputPrompt = document.getElementById('cfg-system-prompt');
  const charsEl = document.getElementById('cfg-chars');
  const tabGemini = document.getElementById('cfg-tab-gemini');
  const tabOR = document.getElementById('cfg-tab-openrouter');

  if (!modal || !btnOpen) return;

  let currentProvider = 'gemini';

  // Provider tab logic
  function setProvider(prov) {
    currentProvider = prov;
    tabGemini.classList.toggle('active', prov === 'gemini');
    tabOR.classList.toggle('active', prov === 'openrouter');
    if (prov === 'gemini') {
      groupGemini.style.display = 'block';
      groupOR.style.display = 'none';
    } else {
      groupGemini.style.display = 'none';
      groupOR.style.display = 'block';
    }
    lucide.createIcons();
  }

  tabGemini.addEventListener('click', () => setProvider('gemini'));
  tabOR.addEventListener('click', () => setProvider('openrouter'));

  // Char counter
  inputPrompt.addEventListener('input', () => {
    charsEl.textContent = inputPrompt.value.length + ' chars';
  });

  // Open modal & load config
  async function openModal() {
    modal.classList.add('open');
    try {
      const res = await fetch('/api/config');
      const data = await res.json();
      if (data.success) {
        const cfg = data.config;
        setProvider(cfg.provider || 'gemini');
        inputGemModel.value = cfg.geminiModel || '';
        inputOrModel.value = cfg.openrouterModel || '';
        inputGemKey.value = cfg.geminiKey || '';
        inputOrKey.value = cfg.openrouterKey || '';
        inputPrompt.value = cfg.systemPrompt || '';
        charsEl.textContent = inputPrompt.value.length + ' chars';
      }
    } catch (e) {
      console.error('[AI Config Modal] Failed to load config:', e);
    }
    lucide.createIcons();
  }

  function closeModal() {
    modal.classList.remove('open');
    saveStatus.className = 'ai-cfg-save-status';
    saveStatus.textContent = '';
  }

  btnOpen.addEventListener('click', openModal);
  btnClose.addEventListener('click', closeModal);
  btnCancel.addEventListener('click', closeModal);
  overlay.addEventListener('click', closeModal);

  // Save config
  btnSave.addEventListener('click', async () => {
    saveStatus.className = 'ai-cfg-save-status saving';
    saveStatus.textContent = 'Saving…';

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: currentProvider,
          geminiModel: inputGemModel.value.trim(),
          openrouterModel: inputOrModel.value.trim(),
          geminiKey: inputGemKey.value.trim(),
          openrouterKey: inputOrKey.value.trim(),
          systemPrompt: inputPrompt.value,
        })
      });
      const data = await res.json();
      if (data.success) {
        saveStatus.className = 'ai-cfg-save-status saved';
        saveStatus.textContent = '✓ Saved';
        setTimeout(() => {
          saveStatus.className = 'ai-cfg-save-status';
          saveStatus.textContent = '';
        }, 2500);
      } else {
        throw new Error(data.error || 'Unknown error');
      }
    } catch (err) {
      saveStatus.className = 'ai-cfg-save-status error';
      saveStatus.textContent = '✗ Error';
      console.error('[AI Config Modal] Save failed:', err);
    }
  });
})();

// Theme Toggle Logic
(function() {
  const themeToggle = document.getElementById('theme-toggle');
  const themeIcon = document.getElementById('theme-icon');

  function applyTheme() {
    const theme = localStorage.getItem('theme') || 'light';
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
      if (themeIcon) {
        themeIcon.setAttribute('data-lucide', 'sun');
      }
    } else {
      document.documentElement.classList.remove('dark');
      if (themeIcon) {
        themeIcon.setAttribute('data-lucide', 'moon');
      }
    }
    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }
  }

  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const isDark = document.documentElement.classList.contains('dark');
      localStorage.setItem('theme', isDark ? 'light' : 'dark');
      applyTheme();
    });
  }

  // Initial apply
  applyTheme();
})();
