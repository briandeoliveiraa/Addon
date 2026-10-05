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

/*jshint esversion: 8 */
/*
* This script compiles the ClearURLs rules into declarativeNetRequest (DNR) rules.
*
* Manifest V3 browsers (Chrome) no longer allow extensions to rewrite requests
* from a blocking webRequest listener. Instead the browser applies declarative
* rules itself, before a request leaves the browser. This file translates the
* ClearURLs rule set into such rules:
*
*   - literal parameter names          -> redirect + queryTransform.removeParams
*   - regular-expression parameter names -> redirect + regexSubstitution
*     (three rules per expression: param in the middle, last param, only param)
*   - rawRules                          -> redirect + regexSubstitution
*   - completeProvider (domain blocking) -> block, main frames go to the alert page
*   - exceptions                        -> allow (same priority as the provider)
*   - ping blocking                     -> block requests of type "ping"
*   - local host skipping               -> allow with top priority
*   - ETag filtering                    -> modifyHeaders (remove ETag)
*
* Fragments (#...) never reach the network layer, so rules that only affect
* fragments are left to the JavaScript engine in clearurls.js, which keeps
* running in observe-only mode (statistics, log, badge, history listener,
* context menu, cleaning tool, redirections and a fallback for main frames).
*
* The compile step (dnrCompileRules) is pure and has no browser dependencies,
* so it can be unit tested with Node.js.
*/

const DNR = {
    PRIORITY_STEP: 10,
    PRIORITY_ETAG: 999999,
    PRIORITY_LOCAL_ALLOW: 1000000,
    PRIORITY_PING_BLOCK: 1000001,
    // chrome.declarativeNetRequest.MAX_NUMBER_OF_REGEX_RULES
    MAX_REGEX_RULES: 1000,
    // chrome.declarativeNetRequest.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES
    MAX_UNSAFE_RULES: 5000,
    // Upper bound for expanding a finite regular expression into literal names
    MAX_EXPANSION: 256,
    // Parameter names per presence check (RE2 memory limit is about 2 KB, see dnrCompileRules)
    LITERAL_CHUNK: 8,
    RESOURCE_TYPES: ["main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object",
        "xmlhttprequest", "ping", "csp_report", "media", "websocket", "webtransport", "webbundle", "other"],
    // Storage keys that influence the generated rules
    SETTINGS_KEYS: ["globalStatus", "domainBlocking", "pingBlocking", "referralMarketing",
        "localHostsSkipping", "eTagFiltering", "types", "ClearURLsData"],
    SETTINGS_DEBOUNCE: 500,
    // Mirrors checkLocalURL() in tools.js
    LOCAL_HOST_REGEX: "^[a-z]+://(?:localhost|127\\.0\\.0\\.1|10\\.\\d+\\.\\d+\\.\\d+|192\\.168\\.\\d+\\.\\d+|" +
        "172\\.(?:1[6-9]|2\\d|3[01])\\.\\d+\\.\\d+|100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.\\d+\\.\\d+|" +
        "169\\.254\\.\\d+\\.\\d+)(?::\\d+)?(?:[/?#]|$)"
};

/**
 * Cartesian concatenation of two string lists.
 */
function dnrProduct(a, b) {
    const out = [];
    for (const x of a) {
        for (const y of b) {
            out.push(x + y);
        }
    }
    return out;
}

/**
 * Expands a finite regular expression (the ClearURLs rule for a parameter name)
 * into the list of literal names it matches, e.g. `fb_(?:source|ref)` becomes
 * ["fb_source", "fb_ref"]. Returns null when the expression is unbounded
 * (`*`, `+`, `.`, `\d`, ...) or would expand to more than `limit` names.
 *
 * @param {string} rule    RegExp source as used in the rules file
 * @param {number} limit   maximum number of literal names
 * @return {string[]|null}
 */
function dnrExpandRule(rule, limit = DNR.MAX_EXPANSION) {
    let pos = 0;
    const fail = () => {
        throw new Error("unsupported");
    };

    function parseAlt() {
        let result = parseSeq();
        while (pos < rule.length && rule[pos] === '|') {
            pos++;
            result = result.concat(parseSeq());
            if (result.length > limit) fail();
        }
        return result;
    }

    function parseSeq() {
        let results = [''];
        while (pos < rule.length && rule[pos] !== '|' && rule[pos] !== ')') {
            const atom = parseAtom();
            const [min, max] = parseQuant();
            let combos = [];
            for (let n = min; n <= max; n++) {
                let rep = [''];
                for (let k = 0; k < n; k++) rep = dnrProduct(rep, atom);
                combos = combos.concat(rep);
            }
            results = dnrProduct(results, combos);
            if (results.length > limit) fail();
        }
        return results;
    }

    function parseAtom() {
        const c = rule[pos];
        if (c === '\\') {
            const e = rule[pos + 1];
            if (e === undefined || /[A-Za-z0-9]/.test(e)) fail(); // \d, \w, \s, \b, \u....
            pos += 2;
            return [e];
        }
        if (c === '[') return parseClass();
        if (c === '(') {
            pos++;
            if (rule[pos] === '?') {
                if (rule[pos + 1] === ':') pos += 2;
                else fail();
            }
            const r = parseAlt();
            if (rule[pos] !== ')') fail();
            pos++;
            return r;
        }
        if ('.^$*+?{})|'.includes(c)) fail();
        pos++;
        return [c];
    }

    function parseClass() {
        pos++; // [
        if (rule[pos] === '^') fail();
        const chars = new Set();
        while (pos < rule.length && rule[pos] !== ']') {
            let ch = rule[pos++];
            if (ch === '\\') {
                const e = rule[pos++];
                if (e === undefined) fail();
                if (/[A-Za-z0-9]/.test(e)) {
                    if (e !== 'd') fail();
                    for (let d = 0; d <= 9; d++) chars.add(String(d));
                    continue;
                }
                ch = e;
            }
            if (rule[pos] === '-' && pos + 1 < rule.length && rule[pos + 1] !== ']') {
                pos++;
                let end = rule[pos++];
                if (end === '\\') end = rule[pos++];
                if (end === undefined) fail();
                const a = ch.charCodeAt(0), b = end.charCodeAt(0);
                if (b < a || b - a > limit) fail();
                for (let x = a; x <= b; x++) chars.add(String.fromCharCode(x));
            } else {
                chars.add(ch);
            }
            if (chars.size > limit) fail();
        }
        if (rule[pos] !== ']') fail();
        pos++;
        return [...chars];
    }

    function parseQuant() {
        const c = rule[pos];
        if (c === '?') {
            pos++;
            if (rule[pos] === '?') pos++;
            return [0, 1];
        }
        if (c === '*' || c === '+') fail();
        if (c === '{') {
            const m = /^\{(\d+)(?:,(\d*))?\}/.exec(rule.slice(pos));
            if (!m || m[2] === '') fail();
            pos += m[0].length;
            if (rule[pos] === '?') pos++;
            const min = Number(m[1]);
            const max = m[2] === undefined ? min : Number(m[2]);
            if (max < min || max - min > limit) fail();
            return [min, max];
        }
        return [1, 1];
    }

    try {
        const result = parseAlt();
        if (pos !== rule.length) return null;
        return [...new Set(result)].filter(name => name !== '');
    } catch (e) {
        return null;
    }
}

/**
 * Converts a JavaScript regular expression into RE2 syntax as required by
 * declarativeNetRequest. Capturing groups become non-capturing groups so
 * that the capture groups added by the compiler keep their numbers.
 * Returns null for constructs RE2 does not support (lookaround, backreferences, \u....).
 *
 * @param {string} regex
 * @return {string|null}
 */
function dnrToRE2(regex) {
    let out = '';
    let inClass = false;

    for (let i = 0; i < regex.length; i++) {
        const c = regex[i];

        if (c === '\\') {
            const n = regex[i + 1];
            if (n === undefined) return null;
            if (!inClass && /[1-9]/.test(n)) return null; // backreference
            if (n === 'u' || n === 'c' || n === 'k') return null;
            out += c + n;
            i++;
            continue;
        }

        if (inClass) {
            if (c === ']') inClass = false;
            out += c;
            continue;
        }

        if (c === '[') {
            inClass = true;
            out += c;
            continue;
        }

        if (c === '(') {
            if (regex[i + 1] === '?') {
                const k = regex[i + 2];
                if (k === ':') {
                    out += '(?:';
                    i += 2;
                    continue;
                }
                if (k === '<' && regex[i + 3] !== '=' && regex[i + 3] !== '!') {
                    // named group (?<name>...)
                    const close = regex.indexOf('>', i);
                    if (close < 0) return null;
                    out += '(?:';
                    i = close;
                    continue;
                }
                return null; // lookahead, lookbehind or inline flags
            }
            out += '(?:';
            continue;
        }

        out += c;
    }

    if (inClass) return null;

    try {
        new RegExp(out, 'i');
    } catch (e) {
        return null;
    }

    return out;
}

/**
 * Returns true for url patterns that match every URL (e.g. `.*` of the global rules).
 */
function dnrIsMatchAll(urlPattern) {
    return /^\^?(?:\.\*)?\$?$/.test(urlPattern || '');
}

/**
 * Extracts a literal domain from the two canonical url pattern shapes
 *   ^https?:\/\/(?:[a-z0-9-]+\.)*?example\.com
 *   ^https?:\/\/example\.com
 * so the much cheaper `requestDomains` condition can be used instead of a regex.
 * Returns null for every other shape.
 */
function dnrPatternToDomain(urlPattern) {
    const m = /^\^https\?:\\\/\\\/(?:\(\?:\[a-z0-9-\]\+\\\.\)[*+]\??)?((?:[a-z0-9-]+\\\.)+[a-z0-9-]+)\$?$/i.exec(urlPattern || '');
    return m ? m[1].replace(/\\\./g, '.').toLowerCase() : null;
}

/**
 * Maps the configured webRequest resource types to declarativeNetRequest resource types.
 * Returns null if every type should be matched.
 */
function dnrResourceTypes(types) {
    if (!Array.isArray(types)) return null;
    const out = types.map(t => String(t).trim()).filter(t => DNR.RESOURCE_TYPES.includes(t));
    return out.length ? [...new Set(out)] : null;
}

/**
 * Escapes a string for use inside a regular expression.
 */
function dnrEscapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
}

/**
 * Compiles the ClearURLs rules into declarativeNetRequest rules.
 *
 * Note on `removeParams`: the browser evaluates only the highest priority rule
 * that matches a request. If that rule is a `removeParams` redirect and none of
 * its parameters is present, nothing happens at all, not even for other matching
 * rules. Therefore every `removeParams` rule carries a (case sensitive) regex
 * that requires one of a small chunk of its parameter names to be present, so it
 * never matches without having an effect. Each chunk rule removes the complete
 * literal list of the provider, so one redirect suffices.
 *
 * @param {object} data                 parsed rules file ({providers: {...}})
 * @param {object} settings             relevant ClearURLs settings
 * @param {object} options              blockedPageURL: absolute URL of the "site blocked" page,
 *                                      literalChunk: parameter names per presence check
 * @return {{rules: object[], stats: object}}
 */
function dnrCompileRules(data, settings, options = {}) {
    const rules = [];
    const stats = {providers: 0, literals: 0, regexRules: 0, dropped: 0, skipped: []};
    const providers = (data && data.providers) || {};
    const literalChunk = Math.max(1, options.literalChunk || DNR.LITERAL_CHUNK);
    const types = dnrResourceTypes(settings.types);
    const typesNoMain = (types || DNR.RESOURCE_TYPES).filter(t => t !== 'main_frame');
    const withTypes = (cond) => {
        if (types) cond.resourceTypes = types;
        return cond;
    };
    const condition = (extra) => Object.assign({isUrlFilterCaseSensitive: false}, extra);
    const push = (rule) => {
        rules.push(rule);
        return rule;
    };

    if (settings.pingBlocking) {
        push({
            priority: DNR.PRIORITY_PING_BLOCK,
            action: {type: 'block'},
            condition: condition({resourceTypes: ['ping']})
        });
    }

    if (settings.localHostsSkipping) {
        push({
            priority: DNR.PRIORITY_LOCAL_ALLOW,
            action: {type: 'allow'},
            condition: condition({regexFilter: DNR.LOCAL_HOST_REGEX})
        });
    }

    if (settings.eTagFiltering) {
        push({
            priority: DNR.PRIORITY_ETAG,
            action: {type: 'modifyHeaders', responseHeaders: [{header: 'ETag', operation: 'remove'}]},
            condition: condition({resourceTypes: types || DNR.RESOURCE_TYPES})
        });
    }

    let order = 0;

    for (const name of Object.keys(providers)) {
        const p = providers[name] || {};
        const urlPattern = p.urlPattern || '';
        const isGlobal = dnrIsMatchAll(urlPattern);
        // The global rules get the lowest priority, so the exceptions of other
        // providers (allow rules) never disable another provider's rules.
        const priority = isGlobal ? 1 : DNR.PRIORITY_STEP * (++order);
        const domain = isGlobal ? null : dnrPatternToDomain(urlPattern);
        const methods = (p.methods || []).map(m => String(m).toLowerCase());
        let body = null;

        if (!isGlobal && !domain) {
            body = dnrToRE2(urlPattern.replace(/^\^/, ''));
            if (body === null) {
                stats.skipped.push(name + ': urlPattern');
                continue;
            }
            // e.g. `amazon(?:\.[a-z]{2,}){1,}\/s\?`: the generated expressions match the `?` themselves
            if (body.endsWith('\\?')) body = body.slice(0, -2);
        }

        const PRE = body ? '(?:' + body + ')' : '';
        const scoped = (extra) => {
            const c = condition(extra);
            if (domain) c.requestDomains = [domain];
            if (methods.length) c.requestMethods = methods;
            return c;
        };

        stats.providers++;

        for (const exception of (p.exceptions || [])) {
            const re = dnrToRE2(exception);
            if (re === null) {
                stats.skipped.push(name + ': exception ' + exception);
                continue;
            }
            push({
                priority: priority + 2,
                action: {type: 'allow'},
                condition: condition({regexFilter: re})
            });
        }

        if (p.completeProvider && settings.domainBlocking) {
            if (options.blockedPageURL) {
                push({
                    priority: priority,
                    action: {
                        type: 'redirect',
                        redirect: {regexSubstitution: options.blockedPageURL + '?source=\\0'}
                    },
                    condition: scoped({resourceTypes: ['main_frame'], regexFilter: '^' + PRE + '.*$'})
                });
            } else {
                const c = scoped({resourceTypes: ['main_frame']});
                if (PRE) c.regexFilter = '^' + PRE;
                push({
                    priority: priority,
                    action: {type: 'redirect', redirect: {extensionPath: '/html/siteBlockedAlert.html'}},
                    condition: c
                });
            }

            const c = scoped({resourceTypes: typesNoMain});
            if (PRE) c.regexFilter = '^' + PRE;
            push({priority: priority, action: {type: 'block'}, condition: c});
            continue;
        }

        const paramRules = (p.rules || []).slice();
        if (p.completeProvider) paramRules.push('.*'); // see Provider() in clearurls.js
        if (!settings.referralMarketing) paramRules.push(...(p.referralMarketing || []));

        const literals = new Set();
        const open = [];

        for (const rule of paramRules) {
            const expanded = dnrExpandRule(rule);
            if (expanded) {
                expanded.forEach(l => literals.add(l));
            } else {
                open.push(rule);
            }
        }

        if (literals.size) {
            // removeParams compares percent-decoded keys (e.g. `%3Futm_source` is the key `?utm_source`)
            const removeParams = [...new Set([...literals].map(name => {
                try {
                    return decodeURIComponent(name);
                } catch (e) {
                    return name;
                }
            }))];
            const names = [...literals];
            stats.literals += literals.size;

            for (let i = 0; i < names.length; i += literalChunk) {
                const chunk = names.slice(i, i + literalChunk).map(dnrEscapeRegex).join('|');
                const c = scoped(withTypes({
                    isUrlFilterCaseSensitive: true,
                    regexFilter: '^' + PRE + '[^?#]*\\?(?:[^#&]*&)*?(?:' + chunk + ')(?:[=&]|$)'
                }));
                push({
                    priority: priority,
                    action: {type: 'redirect', redirect: {transform: {queryTransform: {removeParams: removeParams}}}},
                    condition: c
                });
            }
        }

        for (const rule of open) {
            const R = dnrToRE2(rule);
            if (R === null) {
                stats.skipped.push(name + ': rule ' + rule);
                continue;
            }
            // A run of consecutive matching parameters is removed in one go (one redirect).
            // parameter(s) followed by other parameters: keep everything around it
            push({
                priority: priority,
                action: {type: 'redirect', redirect: {regexSubstitution: '\\1\\2'}},
                condition: scoped(withTypes({
                    regexFilter: '^(' + PRE + '[^?#]*\\?(?:[^#&]*&)*?)(?:(?:' + R + ')(?:=[^&#]*)?(?:&|$))+([^#]*)$'
                }))
            });
            // last parameter(s): also drop the `&` in front of it
            push({
                priority: priority + 1,
                action: {type: 'redirect', redirect: {regexSubstitution: '\\1'}},
                condition: scoped(withTypes({
                    regexFilter: '^(' + PRE + '[^?#]*\\?[^#]*?)(?:&(?:' + R + ')(?:=[^&#]*)?)+$'
                }))
            });
            // only parameter(s): also drop the `?`
            push({
                priority: priority + 1,
                action: {type: 'redirect', redirect: {regexSubstitution: '\\1'}},
                condition: scoped(withTypes({
                    regexFilter: '^(' + PRE + '[^?#]*)\\?(?:(?:' + R + ')(?:=[^&#]*)?(?:&|$))+$'
                }))
            });
        }

        for (const raw of (p.rawRules || [])) {
            if (raw.startsWith('#')) continue; // fragments never reach the network layer
            const W = dnrToRE2(raw);
            if (W === null) {
                stats.skipped.push(name + ': rawRule ' + raw);
                continue;
            }
            push({
                priority: priority,
                action: {type: 'redirect', redirect: {regexSubstitution: '\\1\\2'}},
                condition: scoped(withTypes({regexFilter: '^(' + PRE + '.*?)(?:' + W + ')(.*)$'}))
            });
        }
    }

    return {rules: dnrEnforceLimits(rules, stats), stats: stats};
}

/**
 * Enforces the browser limits and assigns consecutive ids. Rules are ordered by
 * importance (infrastructure rules first, then providers in the order of the
 * rules file), so surplus rules are dropped from the end.
 *
 * @param {object[]} rules
 * @param {object} stats    receives `dropped` and `regexRules`
 * @return {object[]}
 */
function dnrEnforceLimits(rules, stats = {}) {
    let regexCount = 0;
    let unsafeCount = 0;
    const kept = [];

    stats.dropped = stats.dropped || 0;

    for (const rule of rules) {
        const isRegex = !!rule.condition.regexFilter;
        const isUnsafe = rule.action.type === 'redirect' || rule.action.type === 'modifyHeaders';

        if ((isRegex && regexCount >= DNR.MAX_REGEX_RULES) || (isUnsafe && unsafeCount >= DNR.MAX_UNSAFE_RULES)) {
            stats.dropped++;
            continue;
        }

        if (isRegex) regexCount++;
        if (isUnsafe) unsafeCount++;
        rule.id = kept.length + 1;
        kept.push(rule);
    }

    stats.regexRules = regexCount;

    return kept;
}

// The presence check of a removeParams rule ends with `(?:[^#&]*&)*?(?:name1|name2)(?:[=&]|$)`
const DNR_PRESENCE_MARK = '(?:[^#&]*&)*?(?:';
const DNR_PRESENCE_SUFFIX = ')(?:[=&]|$)';

/**
 * Splits the presence check of a removeParams rule into two rules with half of
 * the parameter names each (used when the regex exceeds the memory limit).
 * Returns null if the rule cannot be split any further.
 */
function dnrSplitPresenceRule(rule) {
    const regex = rule.condition.regexFilter || '';
    const start = regex.lastIndexOf(DNR_PRESENCE_MARK);

    if (start === -1 || !regex.endsWith(DNR_PRESENCE_SUFFIX)) return null;

    const prefix = regex.slice(0, start + DNR_PRESENCE_MARK.length);
    const names = regex.slice(prefix.length, regex.length - DNR_PRESENCE_SUFFIX.length).split(/(?<!\\)\|/);

    if (names.length < 2) return null;

    const mid = names.length >> 1;

    return [names.slice(0, mid), names.slice(mid)].map(part => {
        const copy = JSON.parse(JSON.stringify(rule));
        copy.condition.regexFilter = prefix + part.join('|') + DNR_PRESENCE_SUFFIX;
        return copy;
    });
}

/*
* ##################################################################
* # Browser integration                                            #
* ##################################################################
*/

let dnrSyncPromise = null;
let dnrSyncQueued = false;
let dnrSettingsTimer = null;

/**
 * Collects the settings that influence the generated rules.
 */
function dnrSettings() {
    return {
        globalStatus: !!storage.globalStatus,
        domainBlocking: !!storage.domainBlocking,
        pingBlocking: !!storage.pingBlocking,
        referralMarketing: !!storage.referralMarketing,
        localHostsSkipping: !!storage.localHostsSkipping,
        eTagFiltering: !!storage.eTagFiltering,
        types: Array.isArray(storage.types) ? storage.types : []
    };
}

/**
 * Returns true for a removeParams rule with a presence check regex (see dnrCompileRules).
 */
function dnrIsPresenceRule(rule) {
    return !!(rule.condition.regexFilter && rule.action.redirect && rule.action.redirect.transform);
}

/**
 * Asks the browser whether it can compile the regex of the given rule.
 *
 * @return {Promise<{ok: boolean, reason: string}>}
 */
async function dnrIsRuleSupported(rule) {
    if (!rule.condition.regexFilter) return {ok: true};

    try {
        const result = await browser.declarativeNetRequest.isRegexSupported({
            regex: rule.condition.regexFilter,
            isCaseSensitive: !!rule.condition.isUrlFilterCaseSensitive,
            requireCapturing: !!(rule.action.redirect && rule.action.redirect.regexSubstitution)
        });

        return {ok: !!result.isSupported, reason: result.reason};
    } catch (e) {
        // let updateDynamicRules decide
        return {ok: true};
    }
}

/**
 * Keeps the rules the browser can compile (RE2 syntax and memory limit).
 * A presence check that exceeds the memory limit is split into two rules with
 * fewer parameter names until it fits.
 *
 * @return {Promise<object[]>}
 */
async function dnrCheckSupported(rules) {
    const supported = [];
    let queue = rules.slice();

    while (queue.length) {
        const results = await Promise.all(queue.map(dnrIsRuleSupported));
        const next = [];

        results.forEach((result, i) => {
            const rule = queue[i];

            if (result.ok) {
                supported.push(rule);
                return;
            }

            const parts = dnrIsPresenceRule(rule) ? dnrSplitPresenceRule(rule) : null;

            if (parts) {
                next.push(...parts);
            } else {
                console.warn("[ClearURLs]: Dropping unsupported DNR regex (" + result.reason + "): " + rule.condition.regexFilter);
            }
        });

        queue = next;
    }

    return dnrEnforceLimits(supported);
}

/**
 * Compiles the rules and makes sure the browser accepts all regexes.
 */
async function dnrCompileSupported(data, settings) {
    const compiled = dnrCompileRules(data, settings, {
        blockedPageURL: browser.runtime.getURL('html/siteBlockedAlert.html')
    });

    if (compiled.stats.skipped.length) {
        console.warn("[ClearURLs]: " + compiled.stats.skipped.length + " rule(s) could not be expressed as DNR rules and are handled by the fallback only: ", compiled.stats.skipped);
    }

    return dnrCheckSupported(compiled.rules);
}

/**
 * Adds rules, bisecting on failure so a single rejected rule does not take the
 * whole rule set down. Returns the rules that could not be added.
 */
async function dnrAddRules(rules) {
    if (!rules.length) return [];

    try {
        await browser.declarativeNetRequest.updateDynamicRules({addRules: rules});
        return [];
    } catch (e) {
        if (rules.length === 1) {
            console.warn("[ClearURLs]: Dropping DNR rule " + JSON.stringify(rules[0]) + ": " + e);
            return rules;
        }

        const mid = rules.length >> 1;
        return (await dnrAddRules(rules.slice(0, mid))).concat(await dnrAddRules(rules.slice(mid)));
    }
}

/**
 * Replaces all dynamic rules with the given rules.
 *
 * @return {number} number of active rules
 */
async function dnrReplaceRules(rules) {
    const existing = await browser.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existing.map(r => r.id);

    try {
        await browser.declarativeNetRequest.updateDynamicRules({removeRuleIds: removeRuleIds, addRules: rules});
        return rules.length;
    } catch (e) {
        console.warn("[ClearURLs]: Could not apply the DNR rules in one go, retrying rule by rule: " + e);
    }

    await browser.declarativeNetRequest.updateDynamicRules({removeRuleIds: removeRuleIds});
    let dropped = await dnrAddRules(rules);

    // Fall back to the static alert page for blocked main frames if the
    // browser rejected the substitution carrying the blocked URL.
    const fallbacks = dropped
        .filter(r => r.action.redirect && r.action.redirect.regexSubstitution && r.action.redirect.regexSubstitution.indexOf('siteBlockedAlert.html') !== -1)
        .map(r => ({
            id: r.id,
            priority: r.priority,
            action: {type: 'redirect', redirect: {extensionPath: '/html/siteBlockedAlert.html'}},
            condition: r.condition
        }));
    const droppedFallbacks = await dnrAddRules(fallbacks);

    return rules.length - dropped.length + fallbacks.length - droppedFallbacks.length;
}

/**
 * Compiles and applies the DNR rules if the rules file or a relevant setting changed.
 * The fingerprint of the last applied rule set is kept in the storage, so the
 * (expensive) rule update only happens when something changed.
 *
 * @param {boolean} force   recompile even if nothing changed
 */
async function dnrSyncNow(force) {
    const settings = dnrSettings();
    const data = storage.ClearURLsData;
    const hasData = !!(data && data.providers);
    const fingerprint = await sha256(JSON.stringify({
        version: browser.runtime.getManifest().version,
        settings: settings,
        data: hasData ? data : null
    }));

    if (!force && fingerprint === storage.dnrFingerprint) {
        const existing = await browser.declarativeNetRequest.getDynamicRules();
        if (existing.length > 0 || !settings.globalStatus || !hasData) return;
    }

    let rules = [];

    if (settings.globalStatus && hasData) {
        rules = await dnrCompileSupported(data, settings);
    }

    const active = await dnrReplaceRules(rules);
    console.log("[ClearURLs]: " + active + " declarativeNetRequest rules active");

    storage.dnrFingerprint = fingerprint;
    saveOnDisk(['dnrFingerprint']);
}

/**
 * Schedules a rule synchronisation. Concurrent calls are merged.
 *
 * @param {boolean} force   recompile even if nothing changed
 * @return {Promise}
 */
function dnrSync(force = false) {
    if (!usesDNR()) return Promise.resolve();

    if (dnrSyncPromise) {
        dnrSyncQueued = true;
        return dnrSyncPromise;
    }

    dnrSyncPromise = dnrSyncNow(force).catch(handleError).finally(() => {
        dnrSyncPromise = null;
        if (dnrSyncQueued) {
            dnrSyncQueued = false;
            dnrSync();
        }
    });

    return dnrSyncPromise;
}

if (typeof usesDNR === 'function' && usesDNR()) {
    // Re-sync when a relevant setting changes (popup switches, settings page, import)
    storageChangeListeners.push(key => {
        if (!DNR.SETTINGS_KEYS.includes(key)) return;

        clearTimeout(dnrSettingsTimer);
        dnrSettingsTimer = setTimeout(() => dnrSync(), DNR.SETTINGS_DEBOUNCE);
    });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {DNR, dnrExpandRule, dnrToRE2, dnrIsMatchAll, dnrPatternToDomain, dnrResourceTypes, dnrEscapeRegex, dnrCompileRules, dnrEnforceLimits, dnrSplitPresenceRule};
}
