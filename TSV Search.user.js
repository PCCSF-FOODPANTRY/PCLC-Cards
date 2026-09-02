// ==UserScript==
// @name         TSV Search
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Ultra-fast TSV search for kiosk mode
// @match        https://panda.sfmfoodbank.org/distro/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function() {
    "use strict";

    // Kiosk-safe no-op debug
    function dbg() {}

    // ---------- KIOSK MODAL ----------
    function showTSVModal(text) {
        const overlay = document.createElement("div");
        overlay.style.position = "fixed";
        overlay.style.top = "0";
        overlay.style.left = "0";
        overlay.style.width = "100%";
        overlay.style.height = "100%";
        overlay.style.background = "rgba(0,0,0,0.7)";
        overlay.style.display = "flex";
        overlay.style.alignItems = "center";
        overlay.style.justifyContent = "center";
        overlay.style.zIndex = "999999999";

        const modal = document.createElement("div");
        modal.style.background = "white";
        modal.style.border = "4px solid red"
        modal.style.padding = "20px";
        modal.style.fontSize = "16px";
        modal.style.width = "480px";
        modal.style.maxHeight = "70%";
        modal.style.overflowY = "auto";
        modal.style.borderRadius = "0";
        modal.style.boxShadow = "none";
        modal.style.transition = "none";

        const pre = document.createElement("pre");
        pre.textContent = text;

        const closeBtn = document.createElement("button");
        closeBtn.textContent = "Close";
        closeBtn.style.marginTop = "10px";
        closeBtn.addEventListener("click", () => overlay.remove());

        modal.appendChild(pre);
        modal.appendChild(closeBtn);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
    }

    // ---------- NORMALIZATION ----------
    function normalizeBarcode(v) {
        return v.toLowerCase().trim().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");
    }

    // ---------- JARO-WINKLER ----------
    function jaroWinkler(a, b) {
        const m = Math.floor(Math.max(a.length, b.length) / 2) - 1;
        let matchesA = new Array(a.length).fill(false);
        let matchesB = new Array(b.length).fill(false);

        let matches = 0;
        for (let i = 0; i < a.length; i++) {
            const start = Math.max(0, i - m);
            const end = Math.min(b.length - 1, i + m);
            for (let j = start; j <= end; j++) {
                if (!matchesB[j] && a[i] === b[j]) {
                    matchesA[i] = true;
                    matchesB[j] = true;
                    matches++;
                    break;
                }
            }
        }

        if (matches === 0) return 0;

        let t = 0, k = 0;
        for (let i = 0; i < a.length; i++) {
            if (matchesA[i]) {
                while (!matchesB[k]) k++;
                if (a[i] !== b[k]) t++;
                k++;
            }
        }

        const jaro = (matches / a.length +
                      matches / b.length +
                      (matches - t / 2) / matches) / 3;

        let prefix = 0;
        for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
            if (a[i] === b[i]) prefix++;
            else break;
        }

        return jaro + prefix * 0.1 * (1 - jaro);
    }

    // ---------- FUZZY SCORE ----------
    function fuzzyScore(a, b) {
        const ta = a.split(" ");
        const tb = b.split(" ");

        let tokenMatches = 0;
        for (const x of ta) {
            for (const y of tb) {
                if (x === y) tokenMatches++;
            }
        }
        const tokenScore = tokenMatches / Math.max(ta.length, tb.length);

        const jw = jaroWinkler(a, b);
        const lenPenalty = Math.abs(a.length - b.length) * 0.02;

        return jw * 0.7 + tokenScore * 0.3 - lenPenalty;
    }

    // ---------- TSV LOADER ----------
    function loadTSV_clean() {
        GM_xmlhttpRequest({
            method: "GET",
            url: "https://raw.githubusercontent.com/PCCSF-FOODPANTRY/PCLC-Cards/refs/heads/main/data.tsv",
            onload: function(response) {
                const raw = response.responseText;
                const lines = raw.split(/\r?\n/);

                const rows = lines
                    .filter(line => line.trim().length > 0)
                    .map(line => line.split("\t"))
                    .filter(cols => cols.length === 4)
                    .map(([barcode, lastname, firstname, actionNote]) => {
                        const fullName = (lastname + " " + firstname).toLowerCase().trim();
                        return {
                            barcode: barcode.trim(),
                            barcodeNorm: normalizeBarcode(barcode),
                            lastname: lastname.trim(),
                            firstname: firstname.trim(),
                            fullName,
                            actionNote: actionNote.trim()
                        };
                    });

                GM_setValue("clientData_clean", rows);

                showTSVModal("TSV Loaded for Lions Club\nRows: " + rows.length);
                attachSearchListener();
            },
            onerror: err => showTSVModal("TSV ERROR:\n" + JSON.stringify(err))
        });
    }

    // ---------- SEARCH: BARCODE ----------
    function searchBarcode(input) {
        const data = GM_getValue("clientData_clean", []);
        const normalizedInput = normalizeBarcode(input);

        let best = null;
        let bestScore = 0;

        for (const row of data) {
            const score = fuzzyScore(row.barcodeNorm, normalizedInput);
            if (score > bestScore) {
                bestScore = score;
                best = row;
            }
        }

        return bestScore >= 0.80 ? best : null;
    }

    // ---------- SEARCH: NAME ----------
    function searchName(inputFull) {
        const data = GM_getValue("clientData_clean", []);
        let best = null;
        let bestScore = 0;

        for (const row of data) {
            const score = fuzzyScore(row.fullName, inputFull);
            if (score > bestScore) {
                bestScore = score;
                best = row;
            }
        }

        return bestScore >= 0.75 ? best : null;
    }

    // ---------- DEBOUNCE + SCANNER DETECTION ----------
    function attachSearchListener() {
        let lastKeyTime = 0;
        let debounceTimer = null;

        const inputField = document.querySelector("input[placeholder='Search Attendees']");
        if (!inputField) return;

        inputField.addEventListener("input", function(event) {
            const now = performance.now();
            const delta = now - lastKeyTime;
            lastKeyTime = now;

            const isScanner = delta < 50;
            const delay = isScanner ? 100 : 1200;

            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                const value = event.target.value.trim().toLowerCase();
                if (!value) return;

                let client = searchBarcode(value);

                if (!client && value.includes(" ")) {
                    client = searchName(value);
                }

                if (client) {
                    showTSVModal(
                        "CLIENT FOUND\n\n" +
                        client.lastname + " " + client.firstname + "\n" +
                        "Barcode: " + client.barcode + "\n" +
                        "Action: " + client.actionNote
                    );
                }
            }, delay);
        });
    }

    // ---------- BOOTSTRAP ----------
    loadTSV_clean();

})();
