/*
 * Copyright (c) 2002-2017 "Neo Technology,"
 * Network Engine for Objects in Lund AB [http://neotechnology.com]
 *
 * This file is part of Neo4j.
 *
 * Neo4j is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

import * as frames from 'shared/modules/stream/streamDuck'
import { getHistory } from 'shared/modules/history/historyDuck'
import { update as updateQueryResult } from 'shared/modules/requests/requestsDuck'
import { getParams } from 'shared/modules/params/paramsDuck'
import { cleanHtml } from 'services/remoteUtils'
import { hostIsAllowed } from 'services/utils'
import remote from 'services/remote'
import { getServerConfig } from 'services/bolt/boltHelpers'
import { handleServerCommand } from 'shared/modules/commands/helpers/server'
import { handleCypherCommand } from 'shared/modules/commands/helpers/cypher'
import { unknownCommand } from 'shared/modules/commands/commandsDuck'
import { handleParamCommand, handleParamsCommand } from 'shared/modules/commands/helpers/params'
import { handleGetConfigCommand, handleUpdateConfigCommand } from 'shared/modules/commands/helpers/config'
import { CouldNotFetchRemoteGuideError, FetchURLError } from 'services/exceptions'
import { parseHttpVerbCommand } from 'shared/modules/commands/helpers/http'

const availableCommands = [{
  name: 'clear',
  match: (cmd) => cmd === 'clear',
  exec: function (action, cmdchar, put) {
    put(frames.clear())
  }
}, {
  name: 'config',
  match: (cmd) => /^config(\s|$)/.test(cmd),
  exec: function (action, cmdchar, put, store) {
    handleUpdateConfigCommand(action, cmdchar, put, store)
    put(frames.add({...action, ...handleGetConfigCommand(action, cmdchar, store)}))
  }
}, {
  name: 'set-param',
  match: (cmd) => /^param\s/.test(cmd),
  exec: function (action, cmdchar, put, store) {
    const res = handleParamCommand(action, cmdchar, put, store)
    put(frames.add({...action, ...res, type: 'param'}))
  }
}, {
  name: 'set-params',
  match: (cmd) => /^params\s/.test(cmd),
  exec: function (action, cmdchar, put, store) {
    const res = handleParamsCommand(action, cmdchar, put, store)
    put(frames.add({...action, ...res, type: 'params', params: getParams(store.getState())}))
  }
}, {
  name: 'params',
  match: (cmd) => /^params$/.test(cmd),
  exec: function (action, cmdchar, put, store) {
    put(frames.add({...action, type: 'params', params: getParams(store.getState())}))
  }
}, {
  name: 'schema',
  match: (cmd) => /^schema$/.test(cmd),
  exec: function (action, cmdchar, put, store) {
    put(frames.add({...action, type: 'schema'}))
  }
}, {
  name: 'sysinfo',
  match: (cmd) => /^sysinfo$/.test(cmd),
  exec: function (action, cmdchar, put, store) {
    put(frames.add({...action, type: 'sysinfo'}))
  }
}, {
  name: 'cypher',
  match: (cmd) => /^cypher$/.test(cmd),
  exec: (action, cmdchar, put, store) => {
    const [id, request] = handleCypherCommand(action, put, getParams(store.getState()))
    put(frames.add({...action, type: 'cypher', requestId: id}))
    return request
      .then((res) => {
        put(updateQueryResult(id, res, 'success'))
        return res
      })
      .catch(function (e) {
        put(updateQueryResult(id, e, 'error'))
        throw e
      })
  }
}, {
  name: 'server',
  match: (cmd) => /^server(\s)/.test(cmd),
  exec: (action, cmdchar, put, store) => {
    const response = handleServerCommand(action, cmdchar, put, store)
    if (response && response.then) {
      response.then((res) => {
        if (res) put(frames.add({...action, ...res}))
      })
    } else if (response) {
      put(frames.add({...action, ...response}))
    }
    return response
  }
}, {
  name: 'play-remote',
  match: (cmd) => /^play(\s|$)https?/.test(cmd),
  exec: function (action, cmdchar, put, store) {
    const url = action.cmd.substr(cmdchar.length + 'play '.length)
    getServerConfig().then((conf) => {
      const whitelist = conf && conf['browser.remote_content_hostname_whitelist']
      if (!hostIsAllowed(url, whitelist.value)) {
        throw new Error('Hostname is not allowed according to server whitelist')
      }
      remote.get(url)
        .then((r) => {
          put(frames.add({...action, type: 'play-remote', result: cleanHtml(r)}))
        }).catch((e) => {
          put(frames.add({...action, type: 'play-remote', error: CouldNotFetchRemoteGuideError(e.name + ': ' + e.message)}))
        })
    }).catch((e) => {
      put(frames.add({...action, type: 'play-remote', error: CouldNotFetchRemoteGuideError(e.name + ': ' + e.message)}))
    })
  }
}, {
  name: 'play',
  match: (cmd) => /^play(\s|$)/.test(cmd),
  exec: function (action, cmdchar, put, store) {
    put(frames.add({...action, type: 'play'}))
  }
}, {
  name: 'history',
  match: (cmd) => cmd === 'history',
  exec: function (action, cmdchar, put, store) {
    const historyState = getHistory(store.getState())
    const newAction = frames.add({ ...action, result: historyState, type: 'history' })
    put(newAction)
    return newAction
  }
}, {
  name: 'queries',
  match: (cmd) => cmd === 'queries',
  exec: (action, cmdchar, put, store) => {
    put(frames.add({ ...action, type: 'queries', result: "{res : 'QUERIES RESULT'}" }))
  }
}, {
  name: 'help',
  match: (cmd) => /^help(\s|$)/.test(cmd),
  exec: function (action, cmdchar, put, store) {
    put(frames.add({...action, type: 'help'}))
  }
}, {
  name: 'http',
  match: (cmd) => /^(get|post|put|delete|head)/i.test(cmd),
  exec: (action, cmdchar, put) => {
    return parseHttpVerbCommand(action.cmd)
      .then((r) => {
        remote.request(r.method, r.url, r.data)
          .then((res) => res.text())
          .then((res) => {
            put(frames.add({...action, result: res, type: 'pre'}))
          })
          .catch((e) => {
            const error = new FetchURLError(e.message)
            put(frames.add({...action, error, type: 'error'}))
          })
      })
      .catch((e) => {
        const error = new Error(e)
        put(frames.add({...action, error, type: 'error'}))
      })
  }
}, {
  name: 'catch-all',
  match: () => true,
  exec: (action, cmdchar, put) => {
    put(unknownCommand(action.cmd))
  }
}]

// First to match wins
const interpret = (cmd) => {
  return availableCommands.reduce((match, candidate) => {
    if (match) return match
    const isMatch = candidate.match(cmd)
    return isMatch ? candidate : null
  }, null)
}

export default {
  interpret
}
