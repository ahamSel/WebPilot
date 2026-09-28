/// <reference types="chrome" />

/**
 * "Connect OpenRouter": OAuth with PKCE, so users approve a key on openrouter.ai
 * instead of pasting one. The key is created for this extension and can be
 * revoked or given a credit limit from the OpenRouter dashboard.
 */

function base64Url(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function connectOpenRouter(): Promise<string> {
    const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const callbackUrl = chrome.identity.getRedirectURL("openrouter");
    const authUrl = `https://openrouter.ai/auth?callback_url=${encodeURIComponent(callbackUrl)}&code_challenge=${challenge}&code_challenge_method=S256`;

    const redirect = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
    const code = redirect ? new URL(redirect).searchParams.get("code") : null;
    if (!code) throw new Error("OpenRouter did not return an authorization code.");

    const response = await fetch("https://openrouter.ai/api/v1/auth/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
    });
    const json = await response.json().catch(() => ({})) as { key?: string; error?: { message?: string } };
    if (!response.ok || !json.key) {
        throw new Error(json.error?.message || `OpenRouter key exchange failed (${response.status}).`);
    }
    return json.key;
}
