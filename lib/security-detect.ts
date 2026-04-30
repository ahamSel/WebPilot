/**
 * Shared login/captcha/robot detection logic.
 * Used by both the main agent and sub-agents.
 */

export interface SecurityCheckResult {
    detected: boolean;
    reason: string | null;
}

/**
 * Detect login pages, security blocks, CAPTCHAs, robot challenges, etc.
 * Returns { detected: true, reason } if the page looks like it needs human intervention.
 */
export function looksLikeLoginOrSecurityBlock(
    text: string,
    title: string,
    elements: any[]
): SecurityCheckResult {
    const t = (text || "").toLowerCase();
    const titleLower = (title || "").toLowerCase();

    // Check for security/captcha blocks
    if (t.includes("captcha") || t.includes("verify you are") || t.includes("are you a robot")) {
        return { detected: true, reason: "captcha" };
    }

    // Check for robot/bot detection pages (walmart, etc.)
    const robotPatterns = [
        "verify your identity",
        "not robots",
        "not a robot",
        "bot detection",
        "automated access",
        "suspicious activity",
        "unusual traffic",
        "access denied",
        "please verify",
        "human verification",
    ];
    for (const pattern of robotPatterns) {
        if (t.includes(pattern)) {
            return { detected: true, reason: "robot_detection" };
        }
    }

    // Check for login pages by title
    const loginTitlePatterns = ["log in", "login", "sign in", "signin", "authenticate", "cas login", "sso"];
    for (const pattern of loginTitlePatterns) {
        if (titleLower.includes(pattern)) {
            return { detected: true, reason: "login_title" };
        }
    }

    // Check for password input fields
    const hasPasswordField = elements.some((el: any) =>
        el.type === "password" ||
        (el.role === "textbox" && (el.label || "").toLowerCase().includes("password"))
    );
    if (hasPasswordField) {
        return { detected: true, reason: "password_field" };
    }

    // Check for common login page text patterns
    const loginTextPatterns = [
        "enter your password",
        "enter password",
        "sign in to",
        "log in to",
        "login to",
        "authentication required",
        "please sign in",
        "please log in",
        "username and password",
        "enter your credentials",
    ];
    for (const pattern of loginTextPatterns) {
        if (t.includes(pattern)) {
            return { detected: true, reason: "login_text" };
        }
    }

    return { detected: false, reason: null };
}
