export function createTelemetryReporter({
    endpoint = '/api/telemetry',
    limitPerMinute = 90
} = {}) {
    const sentTimestamps = [];

    return (payload = {}) => {
        const now = Date.now();
        while (sentTimestamps.length > 0 && (now - sentTimestamps[0]) > 60_000) {
            sentTimestamps.shift();
        }
        if (sentTimestamps.length >= limitPerMinute) {
            return;
        }
        sentTimestamps.push(now);

        const body = JSON.stringify({
            timestamp: now,
            ...payload
        });

        try {
            if (navigator.sendBeacon) {
                const blob = new Blob([body], { type: 'application/json' });
                if (navigator.sendBeacon(endpoint, blob)) {
                    return;
                }
            }
        } catch {
            // Fall through to fetch.
        }

        fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            keepalive: true
        }).catch(() => {});
    };
}
