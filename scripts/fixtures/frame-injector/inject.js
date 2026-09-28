// Opening any page with ?pm=1 turns the injector on for the rest of the tab's session.
if (new URLSearchParams(location.search).get("pm") === "1") sessionStorage.setItem("frame-injector", "on");
if (sessionStorage.getItem("frame-injector") === "on") {
    const frame = document.createElement("iframe");
    frame.src = chrome.runtime.getURL("frame.html");
    frame.title = "Password manager";
    frame.style.cssText = "position:fixed;right:8px;bottom:8px;width:160px;height:40px;border:1px solid #ccc;z-index:2147483647";
    document.documentElement.appendChild(frame);
}
