/** Preload that pins Date.now to STATUSLINE_TEST_NOW (epoch seconds). */
'use strict';

const now = Number(process.env.STATUSLINE_TEST_NOW);
if (Number.isFinite(now)) Date.now = () => now * 1000;
