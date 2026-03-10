const roomCode = new URLSearchParams(window.location.search).get('room')?.trim().toUpperCase() || '';
const els = {
    roomBadge: document.getElementById('room-badge'),
    diagnosticsLink: document.getElementById('diagnostics-tool-link'),
    installCard: document.getElementById('install-tool-card'),
    installButton: document.getElementById('install-tool-button'),
    playerCard: document.getElementById('player-tool-card'),
    playerLink: document.getElementById('player-tool-link')
};

let deferredInstallPrompt = null;
const installDisplayModeQuery = window.matchMedia ? window.matchMedia('(display-mode: standalone)') : null;

function setCardVisible(card, visible) {
    if (!card) {
        return;
    }

    if (!visible) {
        card.classList.remove('is-revealed');
        card.hidden = true;
        return;
    }

    card.hidden = false;
    window.requestAnimationFrame(() => {
        card.classList.add('is-revealed');
    });
}

function isStandaloneApp() {
    return (installDisplayModeQuery?.matches ?? false) || window.navigator.standalone === true;
}

function updateInstallUi() {
    const visible = Boolean(deferredInstallPrompt) && !isStandaloneApp();
    setCardVisible(els.installCard, visible);
}

function applyRoomContext() {
    if (!roomCode) {
        return;
    }

    els.roomBadge.hidden = false;
    els.roomBadge.textContent = `Room ${roomCode}`;
    window.requestAnimationFrame(() => {
    els.roomBadge.classList.add('is-visible');
    });
    els.diagnosticsLink.href = `/diagnostics.html?room=${encodeURIComponent(roomCode)}`;
    setCardVisible(els.playerCard, true);
    els.playerLink.href = `/player.html?room=${encodeURIComponent(roomCode)}`;
}

els.installButton?.addEventListener('click', async () => {
    if (!deferredInstallPrompt) {
        return;
    }
    const promptEvent = deferredInstallPrompt;
    deferredInstallPrompt = null;
    updateInstallUi();
    try {
        await promptEvent.prompt();
        await promptEvent.userChoice;
    } catch (error) {
        console.error('[TOOLS INSTALL]', error);
    }
});

window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    updateInstallUi();
});

window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    updateInstallUi();
});

installDisplayModeQuery?.addEventListener?.('change', updateInstallUi);
applyRoomContext();
updateInstallUi();
window.requestAnimationFrame(() => {
    document.body.classList.add('page-ready');
});
