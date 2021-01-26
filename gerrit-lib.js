const path = require('path')

const fetch = require('node-fetch')
const debug = require('debug')('gerrit-lib')
const fs = require('fs')
const config = require('config')

const SPOTLIGHT_RECORDS = 100
const NON_WIP_RECORDS = 200
const WIP_RECORDS = 300

const LOG_FILENAME = 'snapshot-log'
const EMPTY_LOG_TEMPLATE = { latest: false, previous: false }

class Gerrit {
  constructor() {
    this.data = false
    this.parsed = false
    this.fetchDate = false
    this.log = false
    this.latestTimestamp = false
    this.prevTimestamp = false

    // Create the log file if it doesn't exist
    if (
      !fs.existsSync(
        config.dataDir + path.sep + LOG_FILENAME + config.dataFileExt
      )
    ) {
      // debug(`Log file doesn't exist... Creating it.`)
      this.previous = false
      fs.writeFileSync(
        config.dataDir + path.sep + LOG_FILENAME + config.dataFileExt,
        JSON.stringify(EMPTY_LOG_TEMPLATE)
      )
      debug(`Log file didn't exist, so created it [EMPTY_LOG_TEMPLATE].`)
    }
  }

  readLogFile() {
    debug(`readLogFile() called`)
    let filename = config.dataDir + path.sep + LOG_FILENAME + config.dataFileExt
    if (fs.existsSync(filename)) {
      // debug(`readLogFile() called`)
      this.log = fs.readFileSync(filename)
      return this.log
    } else {
      // Log file doesn't exist, so return empty array
      debug(`...file doesn't exist, so returning EMPTY_LOG_TEMPLATE`)
      return EMPTY_LOG_TEMPLATE
    }
  }

  updateLogFile(newLatest) {
    debug(`updateLogFile(${newLatest}) called`)
    // this.readLogFile()
    // Save latest
    if (!this.log) {
      this.log = EMPTY_LOG_TEMPLATE
    }
    debug(`... setting this.log.previous to ${this.log.latest}`)
    this.log.previous = this.log.latest
    this.log.latest = newLatest
    fs.writeFileSync(
      config.dataDir + path.sep + LOG_FILENAME + config.dataFileExt,
      JSON.stringify(this.log)
    )
    return this.log.latest
  }

  getLatestData(status = 'open') {
    this.latestTimestamp = this.log.latest
    return JSON.parse(
      fs.readFileSync(
        config.dataDir +
          path.sep +
          'snapshot-' +
          status +
          '-' +
          this.latestTimestamp +
          config.dataFileExt
      )
    )
  }

  getPreviousData(status = 'open') {
    debug(`getPreviousData(${status}) called...\n\tthis.log.previous = ${this.log.previous}`)
    this.prevTimestamp = this.log.previous
    if (this.log.previous) {
      return JSON.parse(
        fs.readFileSync(
          config.dataDir +
            path.sep +
            'snapshot-' +
            status +
            '-' +
            this.log.previous +
            config.dataFileExt
        )
      )
    } else {
      return {}
    }
  }

  async fetchAndLog(query = 'open') {
    return new Promise(async (resolve, reject) => {
      // First, pull it...
      const response = await fetch(
        config.gerritUrlBase +
          config.gerritUrlPrefix +
          query +
          config.gerritUrlSuffix
      )
      let raw = await response.text()

      // Then clean it...
      if (raw.split(/\r?\n/)[0] == ")]}'") {
        let orig = raw.split(/\r?\n/)
        orig.shift()
        raw = orig.join('')
      }

      // Now store it...
      // - To variables
      let now = Date.now()
      this.data = await JSON.parse(raw)
      this.parsed = true
      this.fetchDate = now
      this.latestTimestamp = now

      if (!fs.existsSync(config.dataDir)) {
        fs.mkdirSync(config.dataDir)
      }
      // - To cache file
      debug(`f&l: writing to data file: `, this.log)
      fs.writeFileSync(
        config.dataDir +
          path.sep +
          'snapshot-' +
          query +
          '-' +
          now +
          config.dataFileExt,
        JSON.stringify(this.log)
      )
      // Update the log
      let result = this.updateLogFile(now)
      debug(`f&l: after updateLogFile(${now})`)
      resolve(this.data.length > 0)
    })
  }

  async delta() {
    return new Promise((resolve, reject) => {
      // Load the latest data
      this.fetchAndLog().then(async () => {
        // What is the prior data?

        /* Note: Have to have at least 2 entries:
         * the current entry (i.e. this.log.processed.length-1)
         * and one or more prior entries
         */
        if (this.log.previous) {
          // Compare
          debug(`...about to call _getUrgentPatches(this.getPreviousData())`)
          let prevUrgent = this._getUrgentPatches(this.getPreviousData())
          debug(`...about to call _getUrgentPatches(this.data)`)
          let nowUrgent = this._getUrgentPatches(this.data)

          // debug(`...prevUrgent items: `, prevUrgent)
          // debug(`...nowUrgent items: `, nowUrgent)

          const deltaList = { count: 0, add: [], drop: [] }
          let prevList = prevUrgent.map(
            (x) =>
              `<${config.gerritUrlBase}/${x.id}|${x.id}>: ${x.subject} (${
                config.has('slack') &&
                config.slack.has('users') &&
                Object.keys(config.slack.users).includes(x.email)
                  ? `<@${config.slack.users[x.email]}>`
                  : `${x.owner} ${x.email}`
              })`
          )
          let nowList = nowUrgent.map(
            (x) =>
              `<${config.gerritUrlBase}/${x.id}|${x.id}>: ${x.subject} (${
                config.has('slack') &&
                config.slack.has('users') &&
                Object.keys(config.slack.users).includes(x.email)
                  ? `<@${config.slack.users[x.email]}>`
                  : `${x.owner} ${x.email}`
              })`
          )

          debug(
            `prev: timestamp: ${this.prevTimestamp}; prevList: ${prevList.join(
              ','
            )}`
          )
          debug(
            `now: timestamp: ${this.fetchDate.getTime()}; nowList: ${nowList.join(
              ','
            )}`
          )

          prevList.forEach((id) => {
            if (!nowList.includes(id)) {
              deltaList.drop.push(id)
              deltaList.count++
            }
          })
          nowList.forEach((id) => {
            if (!prevList.includes(id)) {
              deltaList.add.push(id)
              deltaList.count++
            }
          })
          debug(`deltaList: `, deltaList)

          resolve(deltaList)
        } else {
          // Not enough data points
          debug(
            `Need at least two data points to compare. Returning empty list.`
          )
          resolve([])
        }
      })
    })
  }

  async getUrgentPatches() {
    // return new Promise(async (resolve, reject) => {
      // const data = this.data ? this.data : await this.fetchAndLog()
      debug(`getUrgentPatches() this.data.length: `, this.data.length)
      return(this._getUrgentPatches(this.data))
    // })
  }

  _getUrgentPatches(data) {
    debug(`_getUrgentPatches() called: ${data ? data.length : 'undef'}`)
    const urgentPatches = []
    if (data) {
      data.forEach((d) => {
        if (d.hashtags.length > 0 && d.hashtags.includes('urgent')) {
          urgentPatches.push({
            id: d._number,
            subject: d.subject,
            owner: d.owner.name,
            email: d.owner.email,
            vScore: this.getVScore(d),
          })
        }
      })
    }
    return urgentPatches
  }

  /**
   * Calculate the summary Verified score for the supplied patch
   *
   * @param {object} patch JSON patch data from Gerrit
   * @returns {string|number} Value - return "+1" if Max is 1, otherwise Min
   */
  getVScore(patch) {
    let vScore = 0
    if (patch.labels.Verified && patch.labels.Verified.all) {
      vScore = patch.labels.Verified.all.map((x) => (x.value ? x.value : 0))

      let vScoresMax = vScore.reduce((max, cur) => Math.max(max, cur))
      let vScoresMin = vScore.reduce((min, cur) => Math.min(min, cur))

      if (vScoresMax == 1) {
        vScore = '+1'
      } else if (vScoresMin == -1) {
        return -1
      } else {
        return 0
      }
    }
    return vScore
  }
}

module.exports = Gerrit
