export const MOBILE_RE = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i;

export function isMobileDevice(navigatorObject = navigator) {
    return MOBILE_RE.test(navigatorObject.userAgent || '') || (navigatorObject.maxTouchPoints || 0) > 0;
}

export function detectCapabilities(windowObject = window, navigatorObject = navigator) {
    const ua = navigatorObject.userAgent || '';
    const platform = navigatorObject.platform || '';
    const width = windowObject.innerWidth;
    const height = windowObject.innerHeight;
    const isTouch = (navigatorObject.maxTouchPoints || 0) > 0 || isMobileDevice(navigatorObject);
    const isTablet = isTouch && Math.max(width, height) >= 768 && !MOBILE_RE.test(ua);
    const browser = /edg/i.test(ua)
        ? 'Edge'
        : /chrome|crios/i.test(ua)
            ? 'Chrome'
            : /firefox|fxios/i.test(ua)
                ? 'Firefox'
                : /safari/i.test(ua) && !/chrome|crios|edg/i.test(ua)
                    ? 'Safari'
                    : 'Unknown';
    const profile = /iphone|ipad|ipod/i.test(ua)
        ? 'ios-compat'
        : isMobileDevice(navigatorObject)
            ? 'mobile-safe'
            : isTablet
                ? 'tablet-balanced'
                : 'desktop-full';
    const connection = navigatorObject.connection?.effectiveType || navigatorObject.connection?.type || 'unknown';

    return {
        browser,
        connection,
        isTouch,
        isTablet,
        platform,
        profile,
        screen: `${width}x${height}`
    };
}
