import test from "node:test";
import assert from "node:assert/strict";
import {
    extractDomainFromGoal,
    extractExplicitUrls,
    extractUrlFromGoal,
    trimUrlTrailingPunctuation,
} from "../lib/goal-urls";

test("strips a trailing comma from a URL in prose", () => {
    assert.deepEqual(
        extractExplicitUrls("Go to https://en.wikipedia.org/wiki/Web_browser, click the link…"),
        ["https://en.wikipedia.org/wiki/Web_browser"],
    );
});

test("strips common trailing sentence punctuation", () => {
    for (const suffix of [",", ".", ";", ":", "!", "?", ")", "]", "}", "\"", "'", ".)", "?!", "),"]) {
        assert.equal(
            trimUrlTrailingPunctuation(`https://example.com/path${suffix}`),
            "https://example.com/path",
            `suffix ${JSON.stringify(suffix)}`,
        );
    }
});

test("keeps balanced parentheses that are part of the URL", () => {
    const url = "https://en.wikipedia.org/wiki/Mosaic_(web_browser)";
    assert.deepEqual(extractExplicitUrls(`Open ${url} and summarize it.`), [url]);
    assert.deepEqual(extractExplicitUrls(`Open ${url}.`), [url]);
    assert.deepEqual(extractExplicitUrls(`Read about it (${url}).`), [url]);
    assert.deepEqual(extractExplicitUrls(`See [Mosaic](${url})`), [url]);
});

test("keeps punctuation inside the URL", () => {
    const url = "https://example.com/a.b/c?q=1&x=y:z#frag";
    assert.deepEqual(extractExplicitUrls(`Visit ${url}, then stop.`), [url]);
});

test("extracts multiple URLs and skips empty candidates", () => {
    assert.deepEqual(
        extractExplicitUrls("Compare https://a.example.com/x. and https://b.example.com/y; also https://."),
        ["https://a.example.com/x", "https://b.example.com/y"],
    );
    assert.deepEqual(extractExplicitUrls(""), []);
});

test("extractUrlFromGoal returns the first cleaned URL", () => {
    assert.equal(
        extractUrlFromGoal("Go to https://en.wikipedia.org/wiki/Web_browser, then https://example.com"),
        "https://en.wikipedia.org/wiki/Web_browser",
    );
    assert.equal(extractUrlFromGoal("no url here"), "");
});

test("extractDomainFromGoal handles URLs and bare hosts", () => {
    assert.equal(extractDomainFromGoal("Go to https://En.Wikipedia.org/wiki/Web_browser, click"), "en.wikipedia.org");
    assert.equal(extractDomainFromGoal("Search on example.com."), "example.com");
    assert.equal(extractDomainFromGoal("do something"), "");
});
