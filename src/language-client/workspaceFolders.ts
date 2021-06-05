/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict'

import { CancellationToken, ClientCapabilities, DidChangeWorkspaceFoldersNotification, DidChangeWorkspaceFoldersParams, Disposable, InitializeParams, RPCMessageType, ServerCapabilities, WorkspaceFolder, WorkspaceFoldersChangeEvent, WorkspaceFoldersRequest } from 'vscode-languageserver-protocol'
import workspace from '../workspace'
import os from 'os'
import { BaseLanguageClient, DynamicFeature, NextSignature, RegistrationData } from './client'
import * as UUID from './utils/uuid'
import { URI } from 'vscode-uri'
const logger = require('../util/logger')('language-client-workspaceFolder')

function access<T, K extends keyof T>(target: T | undefined, key: K): T[K] | undefined {
  if (target === void 0) {
    return undefined
  }
  return target[key]
}

function arrayDiff<T>(left: T[], right: T[]): T[] {
  return left.filter(element => !right.includes(element))
}

export interface WorkspaceFolderWorkspaceMiddleware {
  workspaceFolders?: WorkspaceFoldersRequest.MiddlewareSignature
  didChangeWorkspaceFolders?: NextSignature<WorkspaceFoldersChangeEvent, void>
}

export class WorkspaceFoldersFeature implements DynamicFeature<undefined> {

  private _listeners: Map<string, Disposable> = new Map<string, Disposable>()
  private _initialFolders: WorkspaceFolder[] | undefined

  constructor(private _client: BaseLanguageClient) {
  }

  public get messages(): RPCMessageType {
    return DidChangeWorkspaceFoldersNotification.type
  }

  private getValidWorkspaceFolders(): WorkspaceFolder[] | undefined {
    let { workspaceFolders } = workspace
    if (!workspaceFolders || workspaceFolders.length == 0) return undefined
    let home = os.homedir()
    let { ignoredRootPaths } = this._client.clientOptions
    if (!Array.isArray(ignoredRootPaths)) {
      ignoredRootPaths = []
    }
    let arr = workspaceFolders.filter(o => {
      let fsPath = URI.parse(o.uri).fsPath
      return fsPath != home && !ignoredRootPaths.includes(fsPath)
    })
    return arr.length ? arr : undefined
  }

  private asProtocol(workspaceFolder: WorkspaceFolder): WorkspaceFolder
  private asProtocol(workspaceFolder: undefined): null
  private asProtocol(workspaceFolder: WorkspaceFolder | undefined): WorkspaceFolder | null {
    if (workspaceFolder === void 0) {
      return null
    }
    return { uri: workspaceFolder.uri, name: workspaceFolder.name }
  }

  public fillInitializeParams(params: InitializeParams): void {
    const folders = this.getValidWorkspaceFolders()
    this._initialFolders = folders
    if (folders == null) {
      params.workspaceFolders = null
    } else {
      params.workspaceFolders = folders.map(folder => this.asProtocol(folder))
    }
    // params.workspaceFolders = workspace.workspaceFolders
  }

  public fillClientCapabilities(capabilities: ClientCapabilities): void {
    capabilities.workspace = capabilities.workspace || {}
    capabilities.workspace.workspaceFolders = true
  }

  public initialize(capabilities: ServerCapabilities): void {
    let client = this._client
    client.onRequest(WorkspaceFoldersRequest.type, (token: CancellationToken) => {
      let workspaceFolders: WorkspaceFoldersRequest.HandlerSignature = () => {
        let folders = this.getValidWorkspaceFolders()
        if (folders === void 0) {
          return null
        }
        let result: WorkspaceFolder[] = folders.map(folder => this.asProtocol(folder))
        return result
      }
      let middleware = client.clientOptions.middleware.workspace
      return middleware && middleware.workspaceFolders
        ? middleware.workspaceFolders(token, workspaceFolders)
        : workspaceFolders(token)
    })
    let value = access(access(access(capabilities, 'workspace'), 'workspaceFolders'), 'changeNotifications')
    let id: string | undefined
    if (typeof value === 'string') {
      id = value
    } else if (value === true) {
      id = UUID.generateUuid()
    }
    if (id) {
      this.register(this.messages, {
        id,
        registerOptions: undefined
      })
    }
  }

  private doSendEvent(addedFolders: ReadonlyArray<WorkspaceFolder>, removedFolders: ReadonlyArray<WorkspaceFolder>): void {
    let params: DidChangeWorkspaceFoldersParams = {
      event: {
        added: addedFolders.map(folder => this.asProtocol(folder)),
        removed: removedFolders.map(folder => this.asProtocol(folder))
      }
    }
    this._client.sendNotification(DidChangeWorkspaceFoldersNotification.type, params)
  }

  protected sendInitialEvent(currentWorkspaceFolders: WorkspaceFolder[] | undefined): void {
    if (this._initialFolders && currentWorkspaceFolders) {
      const removed: WorkspaceFolder[] = arrayDiff(this._initialFolders, currentWorkspaceFolders)
      const added: WorkspaceFolder[] = arrayDiff(currentWorkspaceFolders, this._initialFolders)
      if (added.length > 0 || removed.length > 0) {
        this.doSendEvent(added, removed)
      }
    } else if (this._initialFolders) {
      this.doSendEvent([], this._initialFolders)
    } else if (currentWorkspaceFolders) {
      this.doSendEvent(currentWorkspaceFolders, [])
    }
  }

  public register(_message: RPCMessageType, data: RegistrationData<undefined>): void {
    let id = data.id
    let client = this._client
    let disposable = workspace.onDidChangeWorkspaceFolders(event => {
      let didChangeWorkspaceFolders = (event: WorkspaceFoldersChangeEvent) => {
        this.doSendEvent(event.added, event.removed)
      }
      let middleware = client.clientOptions.middleware.workspace
      middleware && middleware.didChangeWorkspaceFolders
        ? middleware.didChangeWorkspaceFolders(event, didChangeWorkspaceFolders)
        : didChangeWorkspaceFolders(event)
    })
    this._listeners.set(id, disposable)
    let workspaceFolders = this.getValidWorkspaceFolders()
    this.sendInitialEvent(workspaceFolders)
  }

  public unregister(id: string): void {
    let disposable = this._listeners.get(id)
    if (disposable === void 0) {
      return
    }
    this._listeners.delete(id)
    disposable.dispose()
  }

  public dispose(): void {
    for (let disposable of this._listeners.values()) {
      disposable.dispose()
    }
    this._listeners.clear()
  }
}
