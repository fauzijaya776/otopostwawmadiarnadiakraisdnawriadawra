'use strict';

const fs = require('fs');
const { PATHS } = require('./paths');

const DEFAULT_STATE = {
  indexPesan: 0,
  totalTerkirim: 0,
  totalGagal: 0,
  terakhirKirim: null,
  riwayat: [],
};

function bacaState() {
  try {
    const s = JSON.parse(fs.readFileSync(PATHS.state, 'utf8'));
    return { ...DEFAULT_STATE, ...s };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function tulisState(state) {
  try {
    const clone = { ...state, riwayat: (state.riwayat || []).slice(-30) };
    fs.writeFileSync(PATHS.state, JSON.stringify(clone, null, 2), 'utf8');
  } catch {
    /* filesystem read-only? abaikan saja, bot tetap jalan */
  }
}

module.exports = { bacaState, tulisState };
