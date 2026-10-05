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
 * This script is responsible for the communication between background and content_scripts.
 */

/**
 * [handleMessage description]
 * @param  request      The message itself. This is a JSON-ifiable object.
 * @param  sender       A runtime.MessageSender object representing the sender of the message.
 * @param  sendResponse A function to call, at most once, to send a response to the message. The function takes a single argument, which may be any JSON-ifiable object. This argument is passed back to the message sender.
 */
function handleMessage(request, sender, sendResponse)
{
    // `globalThis` instead of `window`, so this also works in a service worker
    let fn = globalThis[request.function];

    if(typeof fn !== "function")
    {
        return false;
    }

    // Wait until the storage has been loaded (a service worker may have just been started)
    storageReady
        .then(() => fn.apply(null, request.params))
        .then(response => sendResponse({response}), error => {
            handleError(error);
            sendResponse({response: undefined});
        });

    // Keep the message channel open for the asynchronous response
    return true;
}

browser.runtime.onMessage.addListener(handleMessage);
