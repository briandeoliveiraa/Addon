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
* This script is responsible for setting the badged.
*/

let badges = {};

/*
* A service worker loses its memory when it is terminated, so the per-tab
* counters are mirrored in the session storage (cleared when the browser closes).
*/
const badgesPersisted = isServiceWorker() && typeof browser !== 'undefined' && browser.storage && browser.storage.session;

if (badgesPersisted) {
    browser.storage.session.get('badges').then(items => {
        badges = Object.assign(items.badges || {}, badges);
    }).catch(handleError);
}

function persistBadges() {
    if (badgesPersisted) {
        browser.storage.session.set({badges: badges}).catch(handleError);
    }
}

/**
 * Increases the badged by one.
 */
function increaseBadged(quiet = false, request) {
    if (!quiet) increaseCleanedCounter();

    if(request === null) return;

    const tabId = request.tabId;
    const url = request.url;

    if(tabId === -1) return;

    if (badges[tabId] == null) {
        badges[tabId] = {
            counter: 1,
            lastURL: url
        };
    } else {
        badges[tabId].counter += 1;
    }

    persistBadges();

    checkOSAndroid().then((res) => {
        if (!res) {
            if (storage.badgedStatus && !quiet) {
                getAction().setBadgeText({text: (badges[tabId]).counter.toString(), tabId: tabId}).catch(handleError);
            } else {
                getAction().setBadgeText({text: "", tabId: tabId}).catch(handleError);
            }
        }
    });
}

/**
 * Call by each tab is updated.
 * And if url has changed.
 */
function handleUpdated(tabId, changeInfo, tabInfo) {
    if(!badges[tabId] || !changeInfo.url) return;

    if (badges[tabId].lastURL !== changeInfo.url) {
        badges[tabId] = {
            counter: 0,
            lastURL: tabInfo.url
        };
        persistBadges();
    }
}

/**
 * Forget the counter of closed tabs.
 */
function handleRemoved(tabId) {
    if (badges[tabId]) {
        delete badges[tabId];
        persistBadges();
    }
}

/**
 * Call by each tab is updated.
 */
browser.tabs.onUpdated.addListener(handleUpdated);
browser.tabs.onRemoved.addListener(handleRemoved);
