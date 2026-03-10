export function appendDiagnosticEvent(events, type, detail = '', limit = 12) {
    const timestamp = new Date().toISOString().split('T')[1]?.replace('Z', '') || String(Date.now());
    const line = detail ? `${timestamp} ${type}: ${detail}` : `${timestamp} ${type}`;
    const nextEvents = [line, ...(Array.isArray(events) ? events : [])];
    return nextEvents.slice(0, limit);
}

export function formatDiagnosticsText({
    events = [],
    presenceLabel = 'n/a',
    isLeader = false,
    currentUsers = 0,
    latencyMs = null,
    lastDriftMs = null,
    lastHeartbeatAt = 0,
    socketConnected = false,
    connection = 'unknown',
    profile = 'unknown',
    screen = 'unknown',
    browser = 'unknown',
    platform = 'unknown',
    playbackMode = 'auto',
    videoFile = 'n/a',
    roomCode = 'n/a'
}) {
    return [
        `Room: ${roomCode || 'n/a'}`,
        `Presence: ${presenceLabel}`,
        `Role: ${isLeader ? 'leader' : 'follower'}`,
        `Users: ${currentUsers}`,
        `Latency: ${latencyMs ?? 'n/a'}ms`,
        `Drift: ${lastDriftMs ?? 'n/a'}ms`,
        `Heartbeat: ${lastHeartbeatAt ? `${Math.round((Date.now() - lastHeartbeatAt) / 1000)}s ago` : 'n/a'}`,
        `Connection: ${socketConnected ? 'connected' : 'disconnected'} / ${connection}`,
        `Playback mode: ${playbackMode}`,
        `Device: ${profile} (${screen})`,
        `Browser: ${browser} on ${platform || 'unknown'}`,
        `Video: ${videoFile || 'n/a'}`,
        '',
        'Recent events:',
        ...(events.length > 0 ? events : ['none'])
    ].join('\n');
}
