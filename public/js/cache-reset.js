(function () {
    const reloadMarker = 'tv-cache-reset-complete';
    const cacheNamePattern = /^(togethervideo|tvstack)-/i;

    async function clearPersistentFrontendCaches() {
        let changed = false;

        if ('serviceWorker' in navigator) {
            const registrations = await navigator.serviceWorker.getRegistrations();
            if (registrations.length > 0) {
                changed = true;
                await Promise.all(registrations.map((registration) => registration.unregister().catch(() => false)));
            }
        }

        if ('caches' in window) {
            const cacheKeys = await caches.keys();
            const matchingKeys = cacheKeys.filter((key) => cacheNamePattern.test(key));
            if (matchingKeys.length > 0) {
                changed = true;
                await Promise.all(matchingKeys.map((key) => caches.delete(key).catch(() => false)));
            }
        }

        return changed;
    }

    window.addEventListener('load', async () => {
        try {
            const changed = await clearPersistentFrontendCaches();
            if (changed && !sessionStorage.getItem(reloadMarker)) {
                sessionStorage.setItem(reloadMarker, '1');
                window.location.reload();
                return;
            }
            sessionStorage.removeItem(reloadMarker);
        } catch (error) {
            console.warn('Cache reset skipped:', error);
        }
    }, { once: true });
})();
