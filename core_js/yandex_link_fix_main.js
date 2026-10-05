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

/*
* Manifest V3 (Chrome): runs in the page's main world at document_start and
* prevents Yandex from rewriting the search result links (window._borschik).
* The isolated-world part (core_js/yandex_link_fix.js) removes the tracking attributes.
*/
(function () {
    "use strict";

    try {
        Object.defineProperty(window, '_borschik', {
            value: function () {
                return false;
            },
            writable: false,
            configurable: false
        });
    } catch (e) {
        console.debug('ClearURLs: Failed to hook _borschik property', e);
    }
})();
