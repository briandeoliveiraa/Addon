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
* Service worker entry point for the Manifest V3 (Chrome) build.
*
* Manifest V2 (Firefox) lists these files as background scripts in the manifest;
* a service worker has to pull them in with importScripts() instead. The order
* matches manifest.json, with core_js/dnr.js added for the declarativeNetRequest
* rule compiler that replaces the blocking webRequest listener.
*/
importScripts(
    "/browser-polyfill.js",
    "/core_js/utils/Multimap.js",
    "/core_js/utils/URLHashParams.js",
    "/core_js/message_handler.js",
    "/external_js/ip-range-check.js",
    "/core_js/tools.js",
    "/core_js/badgedHandler.js",
    "/core_js/pureCleaning.js",
    "/core_js/context_menu.js",
    "/core_js/historyListener.js",
    "/clearurls.js",
    "/core_js/storage.js",
    "/core_js/dnr.js",
    "/core_js/watchdog.js",
    "/core_js/eTagFilter.js"
);
