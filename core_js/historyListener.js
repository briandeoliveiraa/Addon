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
* This script is responsible for listen on history changes.
* This technique is often used to inject tracking code into the location bar,
* because all feature events will use the updated URL.
*/

function historyListenerStart() {
    // In a service worker the listener is registered at load time (see below)
    if(storage.historyListenerEnabled && !isServiceWorker()) {
        browser.webNavigation.onHistoryStateUpdated.addListener(historyCleaner);
    }
}

/**
 * Runs in the page: replaces the current history entry with the cleaned URL.
 */
function replaceHistoryStateInPage(url) {
    history.replaceState(null, "", url);
}

/**
* Function that is triggered on history changes. Injects script into page
* to clean links that were pushed to the history stack with the
* history.replaceState method.
* @param  {state object} details The state object is a JavaScript object
* which is associated with the new history entry created by replaceState()
*/
function historyCleaner(details) {
    if(storage.globalStatus && storage.historyListenerEnabled) {
        const urlBefore = details.url;
        const urlAfter = pureCleaning(details.url);

        if(urlBefore !== urlAfter) {
            if (browser.scripting && typeof browser.scripting.executeScript === 'function') {
                // Manifest V3: no code strings, inject a function instead
                browser.scripting.executeScript({
                    target: {tabId: details.tabId, frameIds: [details.frameId]},
                    func: replaceHistoryStateInPage,
                    args: [urlAfter]
                }).then(() => {}, onError);
            } else {
                browser.tabs.executeScript(details.tabId, {
                    frameId: details.frameId,
                    code: 'history.replaceState(null,"",'+JSON.stringify(urlAfter)+');'
                }).then(() => {}, onError);
            }
        }
    }
}

function onError(error) {
    console.log(`[ClearURLs] Error: ${error}`);
}

if (isServiceWorker()) {
    browser.webNavigation.onHistoryStateUpdated.addListener(details => {
        storageReady.then(() => historyCleaner(details)).catch(handleError);
    });
}
