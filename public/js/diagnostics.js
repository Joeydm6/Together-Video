const roomQuery = new URLSearchParams(window.location.search).get('room')?.trim().toUpperCase() || '';
const els = {
    filterInput: document.getElementById('diagnostics-filter'),
    autoRefresh: document.getElementById('diagnostics-autorefresh'),
    copyButton: document.getElementById('copy-diagnostics-json'),
    menuToolsLink: document.getElementById('menu-tools-link'),
    generatedAt: document.getElementById('generated-at'),
    roomSummary: document.getElementById('room-summary'),
    telemetrySummary: document.getElementById('telemetry-summary'),
    sharedRooms: document.getElementById('shared-rooms'),
    directRooms: document.getElementById('direct-rooms'),
    recentTelemetry: document.getElementById('recent-telemetry'),
    refreshButton: document.getElementById('refresh-diagnostics')
};
let latestPayload = null;
let refreshTimer = null;
let hasRenderedOnce = false;
let previousRoomSignatures = new Map();
let previousTelemetryKeys = new Set();
let previousSummaryFingerprint = {
    rooms: '',
    telemetry: ''
};

if (roomQuery && els.menuToolsLink) {
    els.menuToolsLink.href = `/tools.html?room=${encodeURIComponent(roomQuery)}`;
}

function currentFilter() {
    return (els.filterInput?.value || roomQuery || '').trim().toLowerCase();
}

function fmtTime(value) {
    if (!value) {
        return 'n/a';
    }
    return new Date(value).toLocaleString();
}

function fmtAge(value) {
    if (!Number.isFinite(value)) {
        return 'n/a';
    }
    const seconds = Math.max(0, Math.round(value / 1000));
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const restSeconds = seconds % 60;
    return `${minutes}m ${restSeconds}s`;
}

function renderRoomCard(room) {
    const card = document.createElement('article');
    card.className = 'diag-card';
    if (roomQuery && room.roomCode === roomQuery) {
        card.classList.add('is-active');
    }

    const snapshot = room.syncSnapshot || {};
    const clients = Array.isArray(room.clients) ? room.clients : [];
    const clientMarkup = clients.length > 0
        ? clients.map((client) => `
            <li>
                <strong>${client.socketId.slice(0, 8)}</strong>
                <span>${client.isReady ? 'ready' : 'buffering'}</span>
            </li>
        `).join('')
        : '<li><span>No connected clients</span></li>';

    card.innerHTML = `
        <div class="diag-card-header">
            <div>
                <h3>${room.roomCode || 'Direct room'}</h3>
                <p>${room.videoFile || room.roomKey}</p>
            </div>
            <span class="diag-pill">${room.clientCount} viewer${room.clientCount === 1 ? '' : 's'}</span>
        </div>
        <dl class="diag-grid">
            <div><dt>Leader</dt><dd>${room.leaderSocketId ? room.leaderSocketId.slice(0, 8) : 'n/a'}</dd></div>
            <div><dt>Last used</dt><dd>${fmtTime(room.lastUsedAt)}</dd></div>
            <div><dt>Expires in</dt><dd>${room.expiresInMs === null ? 'n/a' : fmtAge(room.expiresInMs)}</dd></div>
            <div><dt>Pending action</dt><dd>${room.pendingAction?.type || 'none'}</dd></div>
            <div><dt>Paused</dt><dd>${snapshot.paused ? 'yes' : 'no'}</dd></div>
            <div><dt>Time</dt><dd>${Number.isFinite(snapshot.time) ? `${snapshot.time.toFixed(1)}s` : 'n/a'}</dd></div>
            <div><dt>Last seek</dt><dd>${snapshot.seekId || 'n/a'}</dd></div>
            <div><dt>Snapshot source</dt><dd>${snapshot.sourceSocketId ? snapshot.sourceSocketId.slice(0, 8) : 'n/a'}</dd></div>
        </dl>
        <div class="diag-subsection">
            <strong>Clients</strong>
            <ul class="diag-list">${clientMarkup}</ul>
        </div>
    `;

    return card;
}

function renderTelemetryEvent(event) {
    const item = document.createElement('li');
    item.className = 'telemetry-item';
    const meta = [
        event.roomCode || 'no-room',
        event.videoFile || 'n/a',
        event.source ? `source: ${event.source}` : null,
        event.playbackMode ? `mode: ${event.playbackMode}` : null,
        event.seekId ? `seek: ${event.seekId}` : null,
        Number.isFinite(event.driftMs) ? `drift: ${event.driftMs}ms` : null
    ].filter(Boolean).map(value => `<span>${value}</span>`).join('');
    item.innerHTML = `
        <strong>${event.type}</strong>
        ${meta}
        <time>${fmtTime(event.timestamp)}</time>
        ${event.detail ? `<p>${event.detail}</p>` : ''}
    `;
    return item;
}

function telemetryKey(event) {
    return [
        event.timestamp,
        event.type,
        event.roomCode,
        event.videoFile,
        event.seekId,
        event.source,
        event.playbackMode,
        event.driftMs,
        event.detail
    ].map((part) => String(part ?? '')).join('|');
}

function roomKey(room) {
    return room.roomCode || room.roomKey || room.videoFile || Math.random().toString(36).slice(2);
}

function roomSignature(room) {
    const snapshot = room.syncSnapshot || {};
    return JSON.stringify({
        clientCount: room.clientCount || 0,
        leaderSocketId: room.leaderSocketId || '',
        pendingAction: room.pendingAction?.type || '',
        paused: Boolean(snapshot.paused),
        time: Number.isFinite(snapshot.time) ? Number(snapshot.time).toFixed(1) : 'n/a',
        lastUsedAt: room.lastUsedAt || 0
    });
}

function renderCountChips(counts) {
    const entries = Object.entries(counts || {}).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) {
        return '<span class="diag-pill muted">No events yet</span>';
    }
    return entries.map(([type, count]) => `<span class="diag-pill">${type}: ${count}</span>`).join('');
}

function matchesFilter(room, filterText) {
    if (!filterText) {
        return true;
    }
    const snapshot = room.syncSnapshot || {};
    return [room.roomCode, room.roomKey, room.videoFile, room.leaderSocketId]
        .concat([snapshot.seekId, snapshot.sourceSocketId])
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(filterText));
}

function matchesTelemetryFilter(event, filterText) {
    if (!filterText) {
        return true;
    }
    return [event.type, event.roomCode, event.videoFile, event.detail, event.seekId, event.source, event.playbackMode, event.driftMs]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(filterText));
}

function renderDiagnostics() {
    if (!latestPayload) {
        return;
    }

    const { roomsData, telemetryData } = latestPayload;
    const filterText = currentFilter();
    const sharedRooms = (Array.isArray(roomsData.sharedRooms) ? roomsData.sharedRooms : []).filter((room) => matchesFilter(room, filterText));
    const directRooms = (Array.isArray(roomsData.directRooms) ? roomsData.directRooms : []).filter((room) => matchesFilter(room, filterText));
    const recentTelemetry = (Array.isArray(telemetryData.recent) ? telemetryData.recent : []).filter((event) => matchesTelemetryFilter(event, filterText));
    const nextRoomSignatures = new Map();
    const nextTelemetryKeys = new Set();
    const roomSummaryFingerprint = JSON.stringify({
        shared: sharedRooms.length,
        direct: directRooms.length,
        filter: filterText
    });
    const telemetrySummaryFingerprint = JSON.stringify({
        total: telemetryData.totalEvents || 0,
        visible: recentTelemetry.length,
        counts: telemetryData.counts || {}
    });

    els.generatedAt.textContent = `Updated ${fmtTime(roomsData.generatedAt || Date.now())}`;
    els.roomSummary.innerHTML = `
        <span class="diag-pill">Shared rooms: ${sharedRooms.length}</span>
        <span class="diag-pill">Direct rooms: ${directRooms.length}</span>
        <span class="diag-pill">${filterText ? `Filter: ${filterText}` : 'No room filter'}</span>
    `;
    els.telemetrySummary.innerHTML = `
        <span class="diag-pill">Total events: ${telemetryData.totalEvents || 0}</span>
        <span class="diag-pill">Visible events: ${recentTelemetry.length}</span>
        ${renderCountChips(telemetryData.counts)}
    `;
    if (hasRenderedOnce && previousSummaryFingerprint.rooms !== roomSummaryFingerprint) {
        els.roomSummary.querySelectorAll('.diag-pill').forEach((pill) => pill.classList.add('is-updated'));
    }
    if (hasRenderedOnce && previousSummaryFingerprint.telemetry !== telemetrySummaryFingerprint) {
        els.telemetrySummary.querySelectorAll('.diag-pill').forEach((pill) => pill.classList.add('is-updated'));
    }

    els.sharedRooms.innerHTML = '';
    if (sharedRooms.length === 0) {
        els.sharedRooms.innerHTML = '<p class="empty-state">No shared rooms active.</p>';
    } else {
        sharedRooms.forEach((room) => {
            const key = roomKey(room);
            const signature = roomSignature(room);
            const card = renderRoomCard(room);
            if (hasRenderedOnce && previousRoomSignatures.get(key) !== signature) {
                card.classList.add('is-updated');
            }
            nextRoomSignatures.set(key, signature);
            els.sharedRooms.appendChild(card);
        });
    }

    els.directRooms.innerHTML = '';
    if (directRooms.length === 0) {
        els.directRooms.innerHTML = '<p class="empty-state">No direct rooms active.</p>';
    } else {
        directRooms.forEach((room) => {
            const key = roomKey(room);
            const signature = roomSignature(room);
            const card = renderRoomCard(room);
            if (hasRenderedOnce && previousRoomSignatures.get(key) !== signature) {
                card.classList.add('is-updated');
            }
            nextRoomSignatures.set(key, signature);
            els.directRooms.appendChild(card);
        });
    }

    els.recentTelemetry.innerHTML = '';
    if (recentTelemetry.length === 0) {
        els.recentTelemetry.innerHTML = '<li class="empty-state">No telemetry captured yet.</li>';
    } else {
        recentTelemetry.forEach((event) => {
            const key = telemetryKey(event);
            const item = renderTelemetryEvent(event);
            if (hasRenderedOnce && !previousTelemetryKeys.has(key)) {
                item.classList.add('is-new');
            }
            nextTelemetryKeys.add(key);
            els.recentTelemetry.appendChild(item);
        });
    }

    previousSummaryFingerprint = {
        rooms: roomSummaryFingerprint,
        telemetry: telemetrySummaryFingerprint
    };
    previousRoomSignatures = nextRoomSignatures;
    previousTelemetryKeys = nextTelemetryKeys;
    hasRenderedOnce = true;
}

async function loadDiagnostics() {
    const [roomsResponse, telemetryResponse] = await Promise.all([
        fetch('/api/diagnostics/rooms'),
        fetch('/api/telemetry/summary')
    ]);

    if (!roomsResponse.ok || !telemetryResponse.ok) {
        throw new Error('Diagnostics endpoint unavailable');
    }

    latestPayload = {
        roomsData: await roomsResponse.json(),
        telemetryData: await telemetryResponse.json()
    };
    renderDiagnostics();
}

function scheduleRefresh() {
    clearInterval(refreshTimer);
    refreshTimer = null;
    if (els.autoRefresh?.checked === false) {
        return;
    }
    refreshTimer = window.setInterval(refresh, 4_000);
}

async function refresh() {
    els.generatedAt.textContent = 'Loading diagnostics...';
    els.generatedAt.classList.add('is-refreshing');
    try {
        await loadDiagnostics();
    } catch (error) {
        console.error('[DIAGNOSTICS]', error);
        els.generatedAt.textContent = 'Failed to load diagnostics';
    } finally {
        els.generatedAt.classList.remove('is-refreshing');
    }
}

els.filterInput?.addEventListener('input', renderDiagnostics);
els.autoRefresh?.addEventListener('change', scheduleRefresh);
els.copyButton?.addEventListener('click', async () => {
    if (!latestPayload) {
        return;
    }
    try {
        await navigator.clipboard.writeText(JSON.stringify(latestPayload, null, 2));
        els.generatedAt.textContent = 'Diagnostics JSON copied';
        window.setTimeout(() => {
            renderDiagnostics();
        }, 1200);
    } catch {
        els.generatedAt.textContent = 'Copy failed';
    }
});
els.refreshButton?.addEventListener('click', refresh);
void refresh();
scheduleRefresh();
window.requestAnimationFrame(() => {
    document.body.classList.add('page-ready');
});
