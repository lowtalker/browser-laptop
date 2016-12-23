/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict'

const electron = require('electron')
const crypto = require('crypto')
const ipcMain = electron.ipcMain
const messages = require('../js/constants/sync/messages')
const categories = require('../js/constants/sync/proto').categories
const syncActions = require('../js/constants/sync/proto').actions
const config = require('../js/constants/appConfig').sync
const appActions = require('../js/actions/appActions')
const AppStore = require('../js/stores/appStore')

const categoryNames = Object.keys(categories)
const categoryMap = {
  'bookmark': 'BOOKMARKS',
  'historySite': 'HISTORY_SITES',
  'siteSetting': 'PREFERENCES',
  'device': 'PREFERENCES'
}

let deviceId = null /** @type {Array|null} */

/**
 * Sends sync records of the same category to the sync server.
 * @param {event.sender} sender
 * @param {number} action
 * @param {Array.<{name: string, value: Object}>} data
 */
const sendSyncRecords = (sender, action, data) => {
  if (!deviceId) {
    throw new Error('Cannot build a sync record because deviceId is not set')
  }
  if (!data || !data.length) {
    return
  }
  const category = categoryMap[data[0].name]
  sender.send(messages.SEND_SYNC_RECORDS, category, data.map((item) => {
    return {
      action,
      deviceId,
      objectId: Array.from(crypto.randomBytes(16)),
      [item.name]: item.value
    }
  }))
}

/**
 * Checks whether a site is a bookmark or a bookmark folder
 * @param {Object} site
 * @returns {boolean}
 */
const isBookmark = (site) => {
  return (site.tags &&
    (site.tags.includes('bookmark') || site.tags.includes('bookmark-folder')))
}

const createSiteData = (site) => {
  let siteData = {}
  ;['location', 'title', 'customTitle', 'favicon', 'lastAccessedTime', 'creationTime'].forEach((field) => {
    siteData[field] = site[field]
  })
  if (isBookmark(site)) {
    return {
      name: 'bookmark',
      value: {
        site: siteData,
        isFolder: site.tags.includes('bookmark-folder'),
        folderId: site.folderId,
        parentFolderId: site.parentFolderId
      }
    }
  } else {
    return {
      name: 'historySite',
      value: siteData
    }
  }
}

const createSiteSettingsData = (hostPattern, setting) => {
  const adControlEnum = {
    showBraveAds: 0,
    blockAds: 1,
    allowAdsAndTracking: 2
  }
  const cookieControlEnum = {
    block3rdPartyCookie: 0,
    allowAllCookies: 1
  }
  const value = {
    hostPattern
  }
  ;['zoomLevel', 'shieldsUp', 'safeBrowsing', 'noScript', 'httpsEverywhere',
  'fingerprintingProtection', 'ledgerPayments', 'ledgerPaymentsShown'].forEach((field) => {
    value[field] = setting[field]
  })
  if (setting.adControl) {
    value.adControl = adControlEnum[setting.adControl]
  }
  if (setting.cookieControl) {
    value.cookieControl = cookieControlEnum[setting.cookieControl]
  }
  return {
    name: 'siteSetting',
    value
  }
}

module.exports.onFirstRun = (sender) => {
  // Sync the device id for this device
  sendSyncRecords(sender, syncActions.CREATE, [{
    name: 'device',
    value: {
      name: 'browser-laptop' // todo: support user-chosen names
    }
  }])
  // Sync old data
  const appState = AppStore.getState()
  const sites = appState.get('sites').toJS()
  const bookmarks = sites ? sites.filter(isBookmark) : null
  if (bookmarks) {
    // Only sync bookmarks for now to save bandwidth
    sendSyncRecords(sender, syncActions.CREATE, bookmarks.map(createSiteData))
  }
  const siteSettings = appState.get('siteSettings').toJS()
  if (siteSettings) {
    sendSyncRecords(sender, syncActions.CREATE,
      Object.keys(siteSettings).map((item) => {
        return createSiteSettingsData(item, siteSettings[item])
      }))
  }
}

module.exports.onSyncReady = (isFirstRun, e) => {
  if (isFirstRun) {
    module.exports.onFirstRun(e.sender)
  }
  ipcMain.on(messages.RECEIVE_SYNC_RECORDS, (event, categoryName, records) => {
    if (categoryNames.includes(categoryName) || !records || !records.length) {
      return
    }
    // TODO: update appstate
  })
  setInterval(() => {
    e.sender.send(messages.FETCH_SYNC_RECORDS, categoryNames)
  }, config.fetchInterval)
}

module.exports.init = function (initialState) {
  if (config.enabled !== true) {
    return
  }
  ipcMain.on(messages.GET_INIT_DATA, (e) => {
    const seed = initialState.seed ? initialState.seed.data : null
    const savedDeviceId = initialState.deviceId ? initialState.deviceId.data : null
    deviceId = savedDeviceId
    e.sender.send(messages.GOT_INIT_DATA, seed, deviceId, config)
  })
  ipcMain.on(messages.SAVE_INIT_DATA, (e, seed, newDeviceId) => {
    if (!deviceId && newDeviceId) {
      deviceId = Array.from(newDeviceId)
    }
    appActions.saveSyncInitData(seed, newDeviceId)
  })
  ipcMain.on(messages.SYNC_READY, module.exports.onSyncReady.bind(null,
    !initialState.seed && !initialState.deviceId))
  ipcMain.on(messages.SYNC_DEBUG, (e, msg) => {
    console.log('sync-client:', msg)
  })
}
