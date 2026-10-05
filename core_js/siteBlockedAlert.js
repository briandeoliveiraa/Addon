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
* This script is responsible for the blocked alert page.
*/

/**
 * Set the text for the UI.
 */
function setText()
{
    document.title = translate('blocked_html_title');
    document.getElementById('title').innerHTML = translate('blocked_html_title');
    document.getElementById('body').innerHTML = translate('blocked_html_body');
    document.getElementById('page').textContent = translate('blocked_html_button');

}

(function() {
    setText();

    // The blocked URL is appended by clearurls.js (URL encoded) or by a
    // declarativeNetRequest rule (raw, may itself contain `&` and `?`),
    // so take everything after `source=` instead of parsing the query string.
    const search = window.location.search;
    const index = search.indexOf("source=");
    let source = index === -1 ? "" : search.substring(index + "source=".length);

    try {
        source = decodeURIComponent(source);
    } catch (e) {
        // keep the raw value
    }

    if (/^https?:\/\//i.test(source)) {
        document.getElementById('page').href = source;
    } else {
        document.getElementById('page').remove();
    }
})();

/**
 * Translate a string with the i18n API.
 *
 * @param {string} string Name of the attribute used for localization
 */
function translate(string)
{
    return browser.i18n.getMessage(string);
}