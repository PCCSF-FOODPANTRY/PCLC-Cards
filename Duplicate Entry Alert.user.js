// ==UserScript==
// @name         Duplicate Entry Alert
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Shows blocking modals for duplicate entries with different durations for valid vs invalid formats, logs activity, and auto-exports logs weekly
// @match        https://panda.sfmfoodbank.org/distro/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// ==/UserScript==

(function () {
    'use strict';

    const FIELD_ID = 'search';
    const STORAGE_KEY = 'tm_number_entries';
    const TIME_LIMIT_MS = 3 * 60 * 60 * 1000; // 3 hours
    const DEBOUNCE_DELAY = 1500;

    // Dual modal durations
    const MODAL_DURATION_VALID = 4000;   // Properly formatted duplicates
    const MODAL_DURATION_INVALID = 1500; // Invalid-format duplicates

    const LOG_KEY = "tm_persistent_log_v2";
    const SITE_PREFIX = "PCLC";

    /* ----------------------------------------------------
       WEEKLY AUTO-EXPORT SETTINGS
    ---------------------------------------------------- */
    const EXPORT_DAY = 4;
    const EXPORT_HOUR = 13;
    const EXPORT_MINUTE = 0;
    const EXPORT_TRACKER_KEY = "tm_last_export_week";

    let debounceTimer = null;

    /* ----------------------------------------------------
       LOGGING SYSTEM
    ---------------------------------------------------- */

    function log(msg) {
        const logs = GM_getValue(LOG_KEY, []);
        logs.push({
            time: new Date().toLocaleString(),
            msg
        });
        GM_setValue(LOG_KEY, logs);
        updateLogPanel();
    }

    function updateLogPanel() {
        const panel = document.getElementById("tm-log-panel-dup");
        if (!panel) return;

        const logs = GM_getValue(LOG_KEY, []);
        panel.innerHTML = logs
            .slice(-20)
            .map(l => `<div><b>${l.time}</b> — ${l.msg}</div>`)
            .join("");

        panel.scrollTop = panel.scrollHeight;
    }

    function createLogPanel() {
        GM_addStyle(`
            #tm-log-panel-dup {
                position: fixed;
                top: 0px;
                right: 255px;
                width: 400px;
                max-height: 10em;
                overflow-y: auto;
                background: #111;
                color: #0f0;
                padding: 10px;
                font-size: 10px;
                border: 2px solid #0f0;
                z-index: 999999;
                font-family: monospace;
                line-height: 1.2em;
            }
        `);

        const panel = document.createElement("div");
        panel.id = "tm-log-panel-dup";
        document.body.appendChild(panel);

        updateLogPanel();
    }

    /* ----------------------------------------------------
       WEEKLY AUTO-EXPORT LOGIC
    ---------------------------------------------------- */

    function autoExportLog() {
        const logs = GM_getValue(LOG_KEY, []);
        if (!logs.length) return;

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${SITE_PREFIX}-duplicate-log-${timestamp}.json`;

        const blob = new Blob([JSON.stringify(logs, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);

        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();

        URL.revokeObjectURL(url);
    }

    function getWeekKey() {
        const now = new Date();
        const year = now.getFullYear();
        const week = Math.floor((now.getTime() - new Date(year, 0, 1).getTime()) / (7 * 24 * 60 * 60 * 1000));
        return `${year}-W${week}`;
    }

    /* ----------------------------------------------------
       DUPLICATE CHECK LOGIC
    ---------------------------------------------------- */

    function loadEntries() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
        } catch {
            return [];
        }
    }

    function saveEntries(entries) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
        } catch (e) {
            log("Error saving entries: " + e);
        }
    }

    function checkDuplicate(value) {
        const now = Date.now();
        let entries = loadEntries();

        entries = entries.filter(entry => now - entry.time <= TIME_LIMIT_MS);

        const duplicate = entries.some(entry => entry.value.toLowerCase() === value.toLowerCase());

        if (!duplicate) {
            entries.push({ value, time: now });
            log(`Saved new entry: ${value}`);
        } else {
            log(`Duplicate detected: ${value}`);
        }

        saveEntries(entries);
        return duplicate;
    }

    function showBlockingModal(message, duration) {
        const overlay = document.createElement('div');
        overlay.id = "tm-dup-modal";
        overlay.style.position = 'fixed';
        overlay.style.top = '0';
        overlay.style.left = '0';
        overlay.style.width = '100%';
        overlay.style.height = '100%';
        overlay.style.background = 'rgba(0,0,0,0.6)';
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.style.zIndex = '999999';
        overlay.style.fontFamily = 'Arial, sans-serif';

        const modal = document.createElement('div');
        modal.style.background = '#fff';
        modal.style.padding = '20px 30px';
        modal.style.borderRadius = '8px';
        modal.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
        modal.style.textAlign = 'center';
        modal.style.maxWidth = '400px';
        modal.style.fontSize = '16px';
        modal.innerHTML = `<strong style="color:red;">⚠ Duplicate Entry</strong><br><br>${message}`;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        document.body.style.pointerEvents = 'none';
        overlay.style.pointerEvents = 'auto';

        setTimeout(() => {
            overlay.remove();
            document.body.style.pointerEvents = 'auto';
        }, duration);
    }

    function inputHandler(event) {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            const value = event.target.value.trim();

            const isValidFormat = /^[A-Za-z0-9-]+$/.test(value);

            if (isValidFormat) {
                log(`Checking: ${value}`);
                if (checkDuplicate(value)) {
                    showBlockingModal(
                        `The entry "<strong>${value}</strong>" was already entered in the last 3 hours!`,
                        MODAL_DURATION_VALID
                    );
                }
            } else if (value.length > 0) {
                log(`Ignored invalid format: ${value}`);

                // Short modal for invalid-format duplicates
                if (checkDuplicate(value)) {
                    showBlockingModal(
                        `Duplicate (non-card) entry: "<strong>${value}</strong>"`,
                        MODAL_DURATION_INVALID
                    );
                }
            }
        }, DEBOUNCE_DELAY);
    }

    function attachListener() {
        const field = document.getElementById(FIELD_ID);
        if (!field) return;

        field.removeEventListener('input', inputHandler);
        field.addEventListener('input', inputHandler, { capture: true });

        field.dataset.tmDupListenerAttached = 'true';
    }

    /* ----------------------------------------------------
       INITIALIZATION
    ---------------------------------------------------- */

    function init() {
        createLogPanel();
        attachListener();

        // WEEKLY AUTO-EXPORT SCHEDULER
        setInterval(() => {
            const now = new Date();

            const isExportTime =
                now.getDay() === EXPORT_DAY &&
                now.getHours() === EXPORT_HOUR &&
                now.getMinutes() === EXPORT_MINUTE;

            if (!isExportTime) return;

            const currentWeek = getWeekKey();
            const lastExportWeek = GM_getValue(EXPORT_TRACKER_KEY, null);

            if (currentWeek !== lastExportWeek) {
                autoExportLog();
                GM_setValue(EXPORT_TRACKER_KEY, currentWeek);
                log("Automatic weekly export completed.");
            }
        }, 60 * 1000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    const observer = new MutationObserver(() => {
        const field = document.getElementById(FIELD_ID);
        if (field && !field.dataset.tmDupListenerAttached) {
            attachListener();
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

})();
