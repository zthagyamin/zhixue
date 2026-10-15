const RETURN_ORIGIN = 'https://app.local';

/** A destination remains root-relative after URL normalization and reparsing. */
export function safeRelativeReturnPath(value: string): string {
    if (!value.startsWith('/') || value.startsWith('//')) return '/';
    let url: URL;
    try {
        url = new URL(value, RETURN_ORIGIN);
    } catch {
        return '/';
    }
    if (url.origin !== RETURN_ORIGIN || url.pathname.startsWith('//')) return '/';

    // Match decoded route names while keeping encoded delimiters inside a segment.
    // The middleware treats both sign-in and sign-out prefixes as auth endpoints.
    let routingPath: string;
    try {
        routingPath = url.pathname.split('/').map(segment =>
            decodeURIComponent(segment).replace(/[\\/?#]/g, char => encodeURIComponent(char)),
        ).join('/').replace(/\/+/g, '/');
    } catch {
        return '/';
    }
    if (routingPath.startsWith('/signin-with-chatgpt') ||
        routingPath.startsWith('/signout-with-chatgpt') ||
        routingPath === '/callback' || routingPath === '/callback/') return '/';

    return `${url.pathname}${url.search}${url.hash}`;
}
