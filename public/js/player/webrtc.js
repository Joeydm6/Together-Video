const DEFAULT_ICE_SERVERS = [
    {
        urls: [
            'stun:stun.l.google.com:19302',
            'stun:stun1.l.google.com:19302'
        ]
    }
];

const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
const canUseWebRtc = () => (
    typeof window !== 'undefined' &&
    typeof window.RTCPeerConnection === 'function' &&
    typeof window.MediaStream === 'function'
);
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent || '');
const getVideoTracks = (stream) => {
    if (!stream || typeof stream.getVideoTracks !== 'function') {
        return [];
    }
    try {
        return stream.getVideoTracks() || [];
    } catch (error) {
        console.debug('[WEBCAM_TRACKS]', error?.message || error);
        return [];
    }
};
const stopStreamTracks = (stream) => {
    if (!stream || typeof stream.getTracks !== 'function') {
        return;
    }
    for (const track of stream.getTracks()) {
        try {
            track.stop();
        } catch (error) {
            console.debug('[WEBCAM_TRACK_STOP]', error?.message || error);
        }
    }
};
const buildCameraConstraints = () => {
    const standard = [
        {
            video: {
                facingMode: { ideal: 'user' },
                width: { ideal: 640 },
                height: { ideal: 360 },
                frameRate: { ideal: 15, max: 24 }
            },
            audio: false
        },
        {
            video: {
                facingMode: { ideal: 'user' }
            },
            audio: false
        },
        { video: true, audio: false }
    ];
    if (!isIOS()) {
        return standard;
    }
    return [
        {
            video: {
                facingMode: 'user'
            },
            audio: false
        },
        {
            video: {
                facingMode: { ideal: 'user' },
                width: { ideal: 640 },
                height: { ideal: 360 }
            },
            audio: false
        },
        { video: true, audio: false }
    ];
};

export function createWebcamController({
    socket,
    onStateChange = () => {},
    onToast = () => {}
} = {}) {
    const state = {
        joined: false,
        leader: false,
        participantCount: 0,
        localEnabled: false,
        localStream: null,
        remoteEnabled: false,
        remoteStream: null,
        remoteSocketId: null,
        peer: null,
        peerGeneration: 0,
        videoTransceiver: null,
        negotiationTimer: null,
        negotiating: false,
        negotiationQueued: false,
        pendingIceCandidates: [],
        settingCamera: false,
        activeCameraRequestId: 0,
        connectionState: 'idle',
        destroyed: false
    };

    const emit = () => {
        onStateChange({
            joined: state.joined,
            leader: state.leader,
            participantCount: state.participantCount,
            localEnabled: state.localEnabled,
            localStream: state.localStream,
            remoteEnabled: state.remoteEnabled,
            remoteStream: state.remoteStream,
            connected: state.connectionState === 'connected',
            connectionState: state.connectionState,
            canToggle: state.joined,
            busy: state.settingCamera,
            buttonLabel: state.localEnabled ? 'Stop Camera' : 'Share Camera',
            statusLabel: computeStatusLabel(),
            dockVisible: Boolean(state.localEnabled || state.remoteEnabled || hasRemoteVideo())
        });
    };

    const computeStatusLabel = () => {
        if (!canUseWebRtc()) {
            return 'Camera sharing is not available on this browser.';
        }
        if (!state.joined) {
            return 'Join the room first to share your camera.';
        }
        if (state.settingCamera) {
            return state.localEnabled ? 'Stopping camera...' : 'Starting camera...';
        }
        if (state.participantCount <= 1) {
            return state.localEnabled ? 'Camera is live. Waiting for a partner.' : 'Turn your camera on whenever you want.';
        }
        if (state.localEnabled && hasRemoteVideo()) {
            return 'Both cameras are live.';
        }
        if (state.localEnabled && state.remoteEnabled) {
            return 'Partner camera is connecting...';
        }
        if (state.localEnabled) {
            return 'Your camera is live. Waiting for partner camera.';
        }
        if (hasRemoteVideo()) {
            return 'Partner camera is live.';
        }
        if (state.remoteEnabled) {
            return 'Partner camera is connecting...';
        }
        return 'Turn your camera on if you want to be visible.';
    };

    const hasRemoteVideo = () => {
        const track = getVideoTracks(state.remoteStream).find((item) => item.readyState !== 'ended');
        return Boolean(track);
    };

    const emitCameraState = ({ force = false } = {}) => {
        if (!socket?.connected || !state.joined) {
            return;
        }
        if (!force && state.destroyed) {
            return;
        }
        socket.emit('webcamStateUpdate', { enabled: state.localEnabled });
    };

    const clearRemoteStream = () => {
        if (!state.remoteStream) {
            return;
        }
        for (const track of state.remoteStream.getTracks()) {
            state.remoteStream.removeTrack(track);
        }
    };

    const closePeer = () => {
        window.clearTimeout(state.negotiationTimer);
        state.negotiationTimer = null;
        state.negotiating = false;
        state.negotiationQueued = false;
        state.pendingIceCandidates = [];
        state.peerGeneration += 1;
        if (state.peer) {
            state.peer.onicecandidate = null;
            state.peer.ontrack = null;
            state.peer.onconnectionstatechange = null;
            state.peer.oniceconnectionstatechange = null;
            try {
                state.peer.close();
            } catch (error) {
                console.debug('[WEBCAM_CLOSE]', error?.message || error);
            }
        }
        state.peer = null;
        state.videoTransceiver = null;
        state.connectionState = state.localEnabled ? 'waiting' : 'idle';
        clearRemoteStream();
        emit();
    };

    const shouldMaintainPeer = () => (
        state.joined &&
        state.participantCount > 1 &&
        Boolean(state.localEnabled || state.remoteEnabled)
    );
    const currentPeerReadyForIce = () => Boolean(state.peer?.remoteDescription);
    const flushPendingIceCandidates = async () => {
        if (!state.peer || !currentPeerReadyForIce() || state.pendingIceCandidates.length === 0) {
            return;
        }
        const pending = [...state.pendingIceCandidates];
        state.pendingIceCandidates = [];
        for (const candidate of pending) {
            try {
                await state.peer.addIceCandidate(candidate);
            } catch (error) {
                console.error('[WEBCAM_ICE_FLUSH]', error);
            }
        }
    };

    const syncLocalTrack = async () => {
        if (!state.peer) {
            return;
        }
        const track = getVideoTracks(state.localStream)[0] || null;
        if (state.videoTransceiver?.sender) {
            const sender = state.videoTransceiver.sender;
            if (sender.track !== track) {
                await sender.replaceTrack(track);
            }
            try {
                state.videoTransceiver.direction = track ? 'sendrecv' : 'recvonly';
            } catch (error) {
                console.debug('[WEBCAM_DIRECTION]', error?.message || error);
            }
            return;
        }
        const senders = typeof state.peer.getSenders === 'function' ? state.peer.getSenders() : [];
        const sender = senders.find((item) => item?.track?.kind === 'video') || senders[0] || null;
        if (sender?.replaceTrack) {
            await sender.replaceTrack(track);
            return;
        }
        if (track && state.localStream && typeof state.peer.addTrack === 'function') {
            state.peer.addTrack(track, state.localStream);
        }
    };

    const createPeer = () => {
        if (!canUseWebRtc()) {
            throw new Error('WebRTC is not available on this browser');
        }
        if (state.peer) {
            return state.peer;
        }
        const peer = new RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS });
        state.peer = peer;
        state.peerGeneration += 1;
        state.pendingIceCandidates = [];
        state.remoteStream = new MediaStream();
        state.connectionState = 'connecting';
        try {
            if (typeof peer.addTransceiver === 'function') {
                state.videoTransceiver = peer.addTransceiver('video', {
                    direction: state.localEnabled ? 'sendrecv' : 'recvonly'
                });
            } else {
                state.videoTransceiver = null;
            }
        } catch (error) {
            console.debug('[WEBCAM_TRANSCEIVER]', error?.message || error);
            state.videoTransceiver = null;
        }
        void syncLocalTrack();
        peer.onicecandidate = (event) => {
            if (!event.candidate || !state.remoteSocketId) {
                return;
            }
            socket.emit('webrtcIceCandidate', {
                targetSocketId: state.remoteSocketId,
                candidate: event.candidate
            });
        };
        peer.ontrack = (event) => {
            if (event.streams?.[0]) {
                state.remoteStream = event.streams[0];
            } else if (event.track) {
                if (!state.remoteStream) {
                    state.remoteStream = new MediaStream();
                }
                state.remoteStream.addTrack(event.track);
            }
            emit();
        };
        peer.onconnectionstatechange = () => {
            const nextState = peer.connectionState || 'connecting';
            state.connectionState = nextState;
            emit();
            if ((nextState === 'failed' || nextState === 'disconnected') && state.leader && shouldMaintainPeer()) {
                closePeer();
                window.setTimeout(() => {
                    if (!state.destroyed) {
                        scheduleNegotiation('retry-after-failure');
                    }
                }, 300);
            }
            if (nextState === 'closed') {
                emit();
            }
        };
        peer.oniceconnectionstatechange = () => {
            if (peer.iceConnectionState === 'failed' && state.leader && shouldMaintainPeer()) {
                closePeer();
                window.setTimeout(() => {
                    if (!state.destroyed) {
                        scheduleNegotiation('retry-after-ice-failure');
                    }
                }, 300);
            }
        };
        emit();
        return peer;
    };

    const scheduleNegotiation = (reason = 'update') => {
        window.clearTimeout(state.negotiationTimer);
        if (!state.leader || !shouldMaintainPeer() || !state.remoteSocketId) {
            if (!shouldMaintainPeer()) {
                closePeer();
            }
            emit();
            return;
        }
        state.negotiationTimer = window.setTimeout(() => {
            void negotiate(reason);
        }, 90);
    };

    const negotiate = async (reason = 'manual') => {
        if (!state.leader || !shouldMaintainPeer() || !state.remoteSocketId) {
            return;
        }
        if (state.negotiating) {
            state.negotiationQueued = true;
            return;
        }
        state.negotiating = true;
        try {
            const peer = createPeer();
            const peerGeneration = state.peerGeneration;
            await syncLocalTrack();
            if (state.peer !== peer || state.peerGeneration !== peerGeneration || peer.signalingState !== 'stable') {
                return;
            }
            const offer = await peer.createOffer();
            if (state.peer !== peer || state.peerGeneration !== peerGeneration) {
                return;
            }
            await peer.setLocalDescription(offer);
            if (state.peer !== peer || state.peerGeneration !== peerGeneration) {
                return;
            }
            socket.emit('webrtcOffer', {
                targetSocketId: state.remoteSocketId,
                description: peer.localDescription,
                reason
            });
            state.connectionState = 'connecting';
            emit();
        } catch (error) {
            console.error('[WEBCAM_NEGOTIATE]', error);
            state.connectionState = 'failed';
            emit();
            onToast('Camera connection could not start', 2200);
            if (!state.destroyed && shouldMaintainPeer()) {
                scheduleNegotiation('retry-after-negotiate-error');
            }
        } finally {
            state.negotiating = false;
            if (state.negotiationQueued && !state.destroyed) {
                state.negotiationQueued = false;
                scheduleNegotiation('queued-negotiation');
            }
        }
    };

    const startCamera = async () => {
        if (state.localEnabled || state.settingCamera) {
            return state.localEnabled;
        }
        if (!canUseWebRtc()) {
            onToast('Camera sharing is not available on this browser', 2500);
            return false;
        }
        if (!navigator.mediaDevices?.getUserMedia) {
            onToast('Camera is not available on this device', 2500);
            return false;
        }
        state.settingCamera = true;
        const requestId = state.activeCameraRequestId + 1;
        state.activeCameraRequestId = requestId;
        emit();
        try {
            let stream = null;
            let lastError = null;
            for (const constraints of buildCameraConstraints()) {
                try {
                    stream = await navigator.mediaDevices.getUserMedia(constraints);
                    if (stream) {
                        break;
                    }
                } catch (error) {
                    lastError = error;
                }
            }
            if (!stream) {
                throw lastError || new Error('Camera could not be started');
            }
            if (state.destroyed || state.activeCameraRequestId !== requestId) {
                stopStreamTracks(stream);
                return false;
            }
            state.localStream = stream;
            state.localEnabled = true;
            state.connectionState = state.participantCount > 1 ? 'waiting' : 'idle';
            for (const track of stream.getTracks()) {
                track.addEventListener('ended', () => {
                    if (!state.destroyed && state.localEnabled) {
                        void stopCamera({ silent: true });
                    }
                }, { once: true });
            }
            emitCameraState({ force: true });
            if (state.participantCount > 1) {
                if (state.leader) {
                    scheduleNegotiation('local-camera-enabled');
                } else if (state.remoteSocketId) {
                    socket.emit('requestWebcamStateSync');
                }
            }
            emit();
            return true;
        } catch (error) {
            console.error('[WEBCAM_START]', error);
            onToast(error?.name === 'NotAllowedError' ? 'Camera permission was denied' : 'Could not start the camera', 2500);
            return false;
        } finally {
            if (state.activeCameraRequestId === requestId) {
                state.settingCamera = false;
            }
            emit();
        }
    };

    const stopCamera = async ({ silent = false } = {}) => {
        if (!state.localEnabled && !state.settingCamera) {
            return;
        }
        state.settingCamera = true;
        state.activeCameraRequestId += 1;
        emit();
        const stream = state.localStream;
        state.localStream = null;
        state.localEnabled = false;
        stopStreamTracks(stream);
        emitCameraState({ force: true });
        if (shouldMaintainPeer()) {
            if (state.leader) {
                scheduleNegotiation('local-camera-disabled');
            }
        } else {
            closePeer();
        }
        state.settingCamera = false;
        emit();
        if (!silent) {
            onToast('Camera stopped', 1400);
        }
    };

    const toggleCamera = async () => {
        if (!state.joined) {
            onToast('Join the room first to share your camera', 1800);
            return false;
        }
        if (state.localEnabled) {
            await stopCamera();
            return false;
        }
        const started = await startCamera();
        if (started) {
            onToast(state.participantCount > 1 ? 'Camera is live for this room' : 'Camera is live. Waiting for partner.', 1800);
        }
        return started;
    };

    const handleOffer = async ({ socketId, description } = {}) => {
        if (!description) {
            return;
        }
        state.remoteSocketId = socketId || state.remoteSocketId;
        try {
            if (state.peer && state.peer.signalingState !== 'stable') {
                closePeer();
            }
            const peer = createPeer();
            const peerGeneration = state.peerGeneration;
            await syncLocalTrack();
            await peer.setRemoteDescription(description);
            if (state.peer !== peer || state.peerGeneration !== peerGeneration) {
                return;
            }
            await flushPendingIceCandidates();
            const answer = await peer.createAnswer();
            if (state.peer !== peer || state.peerGeneration !== peerGeneration) {
                return;
            }
            await peer.setLocalDescription(answer);
            if (state.peer !== peer || state.peerGeneration !== peerGeneration) {
                return;
            }
            socket.emit('webrtcAnswer', {
                targetSocketId: state.remoteSocketId,
                description: peer.localDescription
            });
            state.connectionState = 'connecting';
            emit();
        } catch (error) {
            console.error('[WEBCAM_OFFER]', error);
            state.connectionState = 'failed';
            emit();
        }
    };

    const handleAnswer = async ({ socketId, description } = {}) => {
        if (!description || !state.peer) {
            return;
        }
        state.remoteSocketId = socketId || state.remoteSocketId;
        try {
            await state.peer.setRemoteDescription(description);
            await flushPendingIceCandidates();
            emit();
        } catch (error) {
            console.error('[WEBCAM_ANSWER]', error);
            state.connectionState = 'failed';
            emit();
            if (state.leader && !state.destroyed && shouldMaintainPeer()) {
                closePeer();
                scheduleNegotiation('retry-after-answer-error');
            }
        }
    };

    const handleIceCandidate = async ({ socketId, candidate } = {}) => {
        if (!candidate) {
            return;
        }
        state.remoteSocketId = socketId || state.remoteSocketId;
        try {
            const peer = createPeer();
            if (!peer.remoteDescription) {
                state.pendingIceCandidates.push(candidate);
                return;
            }
            await peer.addIceCandidate(candidate);
        } catch (error) {
            console.error('[WEBCAM_ICE]', error);
        }
    };

    const handleWebcamStateSync = ({ clients } = {}) => {
        const list = Array.isArray(clients) ? clients : [];
        const partner = list.find((client) => client?.id !== socket.id) || null;
        state.remoteSocketId = partner?.id || null;
        state.remoteEnabled = Boolean(partner?.cameraEnabled);
        if (!state.remoteEnabled && !state.localEnabled) {
            closePeer();
        } else if (state.leader) {
            scheduleNegotiation('state-sync');
        }
        emit();
    };

    const handlePartnerCameraState = ({ socketId, cameraEnabled } = {}) => {
        state.remoteSocketId = socketId || state.remoteSocketId;
        state.remoteEnabled = Boolean(cameraEnabled);
        if (!state.remoteEnabled) {
            clearRemoteStream();
            if (!state.localEnabled) {
                closePeer();
            }
        }
        if (state.leader) {
            scheduleNegotiation('partner-camera-state');
        }
        emit();
    };

    const handleHangup = ({ socketId } = {}) => {
        if (socketId && state.remoteSocketId && socketId !== state.remoteSocketId) {
            return;
        }
        clearRemoteStream();
        if (!state.localEnabled) {
            closePeer();
        } else {
            state.connectionState = state.participantCount > 1 ? 'waiting' : 'idle';
        }
        emit();
    };

    const setJoined = (joined) => {
        state.joined = Boolean(joined);
        if (state.joined) {
            emitCameraState({ force: true });
            socket.emit('requestWebcamStateSync');
        }
        emit();
    };

    const setLeader = (leader) => {
        const changed = state.leader !== Boolean(leader);
        state.leader = Boolean(leader);
        if (changed && state.leader) {
            scheduleNegotiation('leader-changed');
        }
        emit();
    };

    const setParticipantCount = (count) => {
        const previous = state.participantCount;
        state.participantCount = Number(count) || 0;
        if (state.participantCount <= 1) {
            state.remoteSocketId = null;
            state.remoteEnabled = false;
            closePeer();
        } else if (state.joined && state.participantCount !== previous) {
            socket.emit('requestWebcamStateSync');
            if (state.leader) {
                scheduleNegotiation('participant-count');
            }
        }
        emit();
    };

    const handlePartnerLeft = () => {
        state.remoteSocketId = null;
        state.remoteEnabled = false;
        clearRemoteStream();
        closePeer();
        emit();
    };

    const handleDisconnect = () => {
        state.activeCameraRequestId += 1;
        state.settingCamera = false;
        closePeer();
        emit();
    };

    const cleanup = async () => {
        state.destroyed = true;
        emitCameraState({ force: true });
        socket.emit('webrtcHangup', { targetSocketId: state.remoteSocketId || null });
        await wait(10);
        await stopCamera({ silent: true });
        closePeer();
    };

    emit();

    return {
        cleanup,
        handleAnswer,
        handleDisconnect,
        handleHangup,
        handleIceCandidate,
        handleOffer,
        handlePartnerCameraState,
        handlePartnerLeft,
        handleWebcamStateSync,
        setJoined,
        setLeader,
        setParticipantCount,
        toggleCamera
    };
}
