"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPrimaryPublicPage = getPrimaryPublicPage;
exports.getStorePath = getStorePath;
exports.getLinkHubPath = getLinkHubPath;
exports.getProductPath = getProductPath;
exports.getBundlePath = getBundlePath;
exports.getCheckoutPath = getCheckoutPath;
exports.getBundleCheckoutPath = getBundleCheckoutPath;
exports.withPreservedQuery = withPreservedQuery;
function getPrimaryPublicPage(value) {
    return value === 'linkhub' ? 'linkhub' : 'store';
}
function getStorePath(username, primaryPage = 'store') {
    return primaryPage === 'store' ? `/${username}` : `/store/${username}`;
}
function getLinkHubPath(username, primaryPage = 'store') {
    return primaryPage === 'linkhub' ? `/${username}` : `/links/${username}`;
}
function getProductPath(username, slug, _primaryPage) {
    return `/store/${username}/product/${slug}`;
}
function getBundlePath(username, slug, _primaryPage) {
    return `/store/${username}/bundle/${slug}`;
}
function getCheckoutPath(username, id, _primaryPage) {
    return `/store/${username}/checkout/${id}`;
}
function getBundleCheckoutPath(username, id) {
    return `/store/${username}/checkout/bundle/${id}`;
}
function withPreservedQuery(path, searchParams) {
    if (!searchParams)
        return path;
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(searchParams)) {
        if (Array.isArray(value))
            value.forEach(item => query.append(key, item));
        else if (typeof value === 'string')
            query.set(key, value);
    }
    const encoded = query.toString();
    return encoded ? `${path}?${encoded}` : path;
}
