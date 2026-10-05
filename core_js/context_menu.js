/*
* ClearURLs
* Copyright (c) 2017-2025 Kevin Röbert
*
* This program is free software: you can redistribute it and/or modify
* it under the terms of the GNU Lesser General Public License as published by
* the Free Software Foundation, either version 3 of the License, or
* (at your option) any later version.
*
* This program is distributed in the hope that it will be useful,
* but WITHOUT ANY WARRANTY; without even the implied warranty of
* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
* GNU Lesser General Public License for more details.
*
* You should have received a copy of the GNU Lesser General Public License
* along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

/*jshint esversion: 6 */
/*
* This script is responsible for context menu cleaning functions
* and based on: https://github.com/mdn/webextensions-examples/tree/master/context-menu-copy-link-with-types
*/

const CONTEXT_MENU_ID = "copy-link-to-clipboard";

function contextMenuStart() {
    const create = () => {
        browser.contextMenus.create({
            id: CONTEXT_MENU_ID,
            title: translate("clipboard_copy_link"),
            contexts: ["link"]
        }, () => {
            // Ignore "duplicate id" errors (menu entries survive service worker restarts)
            void browser.runtime.lastError;
        });
    };

    if (isServiceWorker()) {
        // The menu entry persists across service worker restarts, so start from a clean state
        browser.contextMenus.removeAll().then(() => {
            if (storage.contextMenuEnabled) create();
        }, handleError);
    } else if (storage.contextMenuEnabled) {
        create();
    }
}

/**
 * Runs in the page: copies the given text to the clipboard.
 */
function copyToClipboardInPage(text) {
    function oncopy(event) {
        document.removeEventListener("copy", oncopy, true);
        event.stopImmediatePropagation();
        event.preventDefault();
        event.clipboardData.setData("text/plain", text);
    }

    const legacyCopy = () => {
        document.addEventListener("copy", oncopy, true);
        document.execCommand("copy");
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(legacyCopy);
    } else {
        legacyCopy();
    }
}

/**
 * Copies the given (cleaned) URL to the clipboard of the given tab.
 */
function copyCleanLink(tab, url) {
    if (browser.scripting && typeof browser.scripting.executeScript === 'function') {
        // Manifest V3: no code strings, inject a function instead
        return browser.scripting.executeScript({
            target: {tabId: tab.id},
            func: copyToClipboardInPage,
            args: [url]
        }).catch((error) => {
            console.error("Failed to copy text: " + error);
        });
    }

    const code = "copyToClipboard(" + JSON.stringify(url) + ");";

    return browser.tabs.executeScript({
        code: "typeof copyToClipboard === 'function';",
    }).then((results) => {
        if (!results || results[0] !== true) {
            return browser.tabs.executeScript(tab.id, {
                file: "/external_js/clipboard-helper.js",
            }).catch(handleError);
        }
    }).then(() => {
        return browser.tabs.executeScript(tab.id, {
            code,
        });
    }).catch((error) => {
        console.error("Failed to copy text: " + error);
    });
}

/*
* Registered at load time, so a terminated service worker is woken up by the click.
*/
browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== CONTEXT_MENU_ID) return;

    storageReady.then(() => {
        const url = pureCleaning(info.linkUrl);
        copyCleanLink(tab, url);
    }).catch(handleError);
});
