const URL_CANDIDATE_RE = /https?:\/\/[^\s"'`<>]+/gi;
const TRAILING_PUNCTUATION = new Set([",", ".", ";", ":", "!", "?", "\"", "'"]);
const BRACKET_PAIRS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function countChar(text: string, char: string): number {
    let count = 0;
    for (const c of text) {
        if (c === char) count++;
    }
    return count;
}

/**
 * Strip sentence punctuation that trails a URL in prose, e.g. "https://a.com/x," or
 * "(see https://a.com/x)". Closing brackets are kept when they balance an opening
 * bracket inside the URL, so "https://en.wikipedia.org/wiki/Mosaic_(web_browser)" survives.
 */
export function trimUrlTrailingPunctuation(url: string): string {
    let result = url;
    while (result.length > 0) {
        const last = result[result.length - 1];
        if (TRAILING_PUNCTUATION.has(last)) {
            result = result.slice(0, -1);
            continue;
        }
        const opener = BRACKET_PAIRS[last];
        if (opener && countChar(result, last) > countChar(result, opener)) {
            result = result.slice(0, -1);
            continue;
        }
        break;
    }
    return result;
}

function isUsableUrl(url: string): boolean {
    try {
        return Boolean(new URL(url).hostname);
    } catch {
        return false;
    }
}

export function extractExplicitUrls(goal: string): string[] {
    return Array.from(String(goal || "").matchAll(URL_CANDIDATE_RE))
        .map((match) => trimUrlTrailingPunctuation(match[0]))
        .filter(isUsableUrl);
}

export function extractUrlFromGoal(goal: string): string {
    return extractExplicitUrls(goal)[0] || "";
}

export function extractDomainFromGoal(goal: string): string {
    const text = String(goal || "").trim();
    if (!text) return "";
    const url = extractUrlFromGoal(text);
    if (url) return new URL(url).hostname.toLowerCase();
    const hostLike = text.match(/\b([a-z0-9.-]+\.[a-z]{2,})\b/i);
    if (hostLike?.[1]) return hostLike[1].toLowerCase();
    return "";
}
