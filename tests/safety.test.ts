import test from "node:test";
import assert from "node:assert/strict";
import { confirmationMessage, irreversibleAction, isSecretField, signInAction } from "../lib/safety";

test("irreversible buttons need confirmation", () => {
    for (const label of ["Buy now", "Place order", "Place your order", "Send", "Send message", "Delete", "Delete conversation", "Pay $89.99", "Proceed to checkout", "Unsubscribe", "Confirm purchase", "Publish"]) {
        assert.ok(irreversibleAction({ role: "button", label }), `${label} should need confirmation`);
    }
    assert.equal(irreversibleAction({ role: "button", label: "Send" }), "button \"Send\"");
});

test("navigation and harmless controls do not", () => {
    for (const [role, label] of [
        ["button", "Search"],
        ["button", "Add to cart"],
        ["button", "Reply"],
        ["button", "Forward"],
        ["link", "Sent items"],
        ["link", "Send feedback about this page"],
        ["link", "Posts"],
        ["link", "Delivery information"],
        ["button", "Show delete options"],
        ["link", "How to delete your account"],
        ["textbox", "Delete reason"],
        ["button", ""],
    ]) {
        assert.equal(irreversibleAction({ role, label }), null, `${role} "${label}" should not need confirmation`);
    }
});

test("strong verbs on links still need confirmation", () => {
    assert.ok(irreversibleAction({ role: "link", label: "Buy now" }));
    assert.ok(irreversibleAction({ role: "link", label: "Checkout" }));
    assert.ok(irreversibleAction({ role: "link", label: "Unsubscribe" }));
    assert.equal(irreversibleAction({ role: "link", label: "Send us a message" }), null);
});

test("labels without a role use the command rules", () => {
    assert.ok(irreversibleAction({ label: "Place order button" }));
    assert.equal(irreversibleAction({ label: "Search results link" }), null);
});

test("confirmation message names the action and site", () => {
    const message = confirmationMessage("button \"Place order\"", "https://shop.example.com/checkout");
    assert.match(message, /button "Place order"/);
    assert.match(message, /shop\.example\.com/);
    assert.match(message, /Resume to allow/);
});

test("password, code and card fields are never typed into", () => {
    for (const name of ["Password:", "Enter your password", "Passcode", "PIN", "One-time code", "Verification code", "CVV", "Card number", "Expiry date"]) {
        assert.ok(isSecretField({ name }), `${name} is secret`);
    }
    assert.ok(isSecretField({ name: "", value: "••••••" }), "a masked value is secret");
    for (const name of ["MUN Login ID or e-mail address:", "Search mail", "Passenger name", "Spinner size", "Pinterest handle"]) {
        assert.equal(isSecretField({ name }), false, `${name} is not secret`);
    }
});

test("signing in with filled-in credentials needs confirmation", () => {
    const login = { elements: [
        { kind: "type", name: "MUN Login ID or e-mail address:", value: "aaesselmouni" },
        { kind: "type", name: "Password:", value: "••••••" },
        { kind: "click", name: "LOG IN" },
    ] };
    assert.equal(signInAction(login, { role: "button", label: "LOG IN" }), "button \"LOG IN\" to sign in with the details filled in");
    assert.ok(signInAction(login, { role: "button", label: "Next" }));
    assert.equal(signInAction(login, { role: "link", label: "Forgot password?" }), null);
    // No password field on the page: an ordinary button.
    assert.equal(signInAction({ elements: [{ kind: "type", name: "Search" }] }, { role: "button", label: "Continue" }), null);
});
