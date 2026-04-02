export const MOBILE_RE = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i;
export const ANDROID_RE = /Android/i;

export function isMobileDevice(navigatorObject = navigator) {
    return MOBILE_RE.test(navigatorObject.userAgent || '') || (navigatorObject.maxTouchPoints || 0) > 0;
}

export function isAndroidDevice(navigatorObject = navigator) {
    return ANDROID_RE.test(navigatorObject.userAgent || '');
}

export function detectCapabilities(windowObject = window, navigatorObject = navigator) {
    const ua = navigatorObject.userAgent || '';
    const platform = navigatorObject.platform || '';
    const width = windowObject.innerWidth;
    const height = windowObject.innerHeight;
    const isTouch = (navigatorObject.maxTouchPoints || 0) > 0 || isMobileDevice(navigatorObject);
    const longEdge = Math.max(width, height);
    const shortEdge = Math.min(width, height);
    const isiPadLike = /iPad/i.test(ua) || (platform === 'MacIntel' && (navigatorObject.maxTouchPoints || 0) > 1);
    const isDesktopPlatform = /Win32|Windows|MacIntel|Linux x86_64/i.test(platform);
    const isAndroidTabletLike = /Android/i.test(ua) && !/Mobile/i.test(ua);
    const genericTabletViewport = !isDesktopPlatform && longEdge >= 900 && shortEdge >= 600;
    const isTablet = Boolean(isTouch && (isiPadLike || isAndroidTabletLike || genericTabletViewport));
    const browser = /edg/i.test(ua)
        ? 'Edge'
        : /chrome|crios/i.test(ua)
            ? 'Chrome'
            : /firefox|fxios/i.test(ua)
                ? 'Firefox'
                : /safari/i.test(ua) && !/chrome|crios|edg/i.test(ua)
                    ? 'Safari'
                    : 'Unknown';
    const profile = /iphone|ipod/i.test(ua)
        ? 'ios-compat'
        : isTablet
            ? 'tablet-balanced'
            : isMobileDevice(navigatorObject)
            ? 'mobile-safe'
            : 'desktop-full';
    const connection = navigatorObject.connection?.effectiveType || navigatorObject.connection?.type || 'unknown';

    return {
        isAndroid: isAndroidDevice(navigatorObject),
        browser,
        connection,
        isTouch,
        isTablet,
        platform,
        profile,
        screen: `${width}x${height}`
    };
}
