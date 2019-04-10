import { Logger, ListenHandle } from 'botpress/sdk'
import { ObjectCache } from 'common/object-cache'
import { isValidBotId } from 'common/validation'
import { forceForwardSlashes } from 'core/misc/utils'
import fse from 'fs-extra'
import { inject, injectable, tagged } from 'inversify'
import _ from 'lodash'
import minimatch from 'minimatch'
import mkdirp from 'mkdirp'
import path from 'path'
import tmp from 'tmp'
import { VError } from 'verror'

import { TYPES } from '../../types'

import { PendingRevisions, ServerWidePendingRevisions, StorageDriver } from '.'
import DBStorageDriver from './db-driver'
import DiskStorageDriver from './disk-driver'
import { EventEmitter2 } from 'eventemitter2'

const tar = require('tar')
const MAX_GHOST_FILE_SIZE = 10 * 1024 * 1024 // 10 Mb

@injectable()
export class GhostService {
  private _scopedGhosts: Map<string, ScopedGhostService> = new Map()
  public enabled: boolean = false

  constructor(
    @inject(TYPES.DiskStorageDriver) private diskDriver: DiskStorageDriver,
    @inject(TYPES.DBStorageDriver) private dbDriver: DBStorageDriver,
    @inject(TYPES.ObjectCache) private cache: ObjectCache,
    @inject(TYPES.Logger)
    @tagged('name', 'GhostService')
    private logger: Logger
  ) {}

  initialize(enabled: boolean) {
    this.enabled = enabled
  }

  global(): ScopedGhostService {
    return new ScopedGhostService(
      `./data/global`,
      this.diskDriver,
      this.dbDriver,
      this.enabled,
      this.cache,
      this.logger
    )
  }

  bots(): ScopedGhostService {
    return new ScopedGhostService(`./data/bots`, this.diskDriver, this.dbDriver, this.enabled, this.cache, this.logger)
  }

  forBot(botId: string): ScopedGhostService {
    if (!isValidBotId(botId)) {
      throw new Error(`Invalid botId "${botId}"`)
    }

    if (this._scopedGhosts.has(botId)) {
      return this._scopedGhosts.get(botId)!
    }

    const scopedGhost = new ScopedGhostService(
      `./data/bots/${botId}`,
      this.diskDriver,
      this.dbDriver,
      this.enabled,
      this.cache,
      this.logger
    )

    process.BOTPRESS_EVENTS.on('after_bot_unmount', args => {
      if (args.botId === botId) {
        scopedGhost.events.removeAllListeners()
      }
    })

    this._scopedGhosts.set(botId, scopedGhost)
    return scopedGhost
  }

  public async exportArchive(botIds: string[]): Promise<Buffer> {
    const tmpDir = tmp.dirSync({ unsafeCleanup: true })
    const files: string[] = []

    try {
      await mkdirp.sync(path.join(tmpDir.name, 'global'))
      const outDir = path.join(tmpDir.name, 'global')
      const outFiles = (await this.global().exportToDirectory(outDir)).map(f => path.join('global', f))
      files.push(...outFiles)

      await Promise.mapSeries(botIds, async bid => {
        const p = path.join(tmpDir.name, `bots/${bid}`)
        await mkdirp.sync(p)
        const outFiles = (await this.forBot(bid).exportToDirectory(p)).map(f => path.join(`bots/${bid}`, f))
        files.push(...outFiles)
      })
      const outFile = path.join(tmpDir.name, 'archive.tgz')

      await tar.create(
        {
          cwd: tmpDir.name,
          file: outFile,
          portable: true,
          gzip: true
        },
        files
      )

      return await fse.readFile(outFile)
    } finally {
      tmpDir.removeCallback()
    }
  }

  public async getPending(botIds: string[]): Promise<ServerWidePendingRevisions | {}> {
    if (!this.enabled) {
      return {}
    }

    const global = await this.global().getPendingChanges()
    const bots = await Promise.mapSeries(botIds, async botId => this.forBot(botId).getPendingChanges())
    return {
      global,
      bots
    }
  }
}

export interface FileContent {
  name: string
  content: string | Buffer
}

export class ScopedGhostService {
  isDirectoryGlob: boolean
  primaryDriver: StorageDriver
  events: EventEmitter2 = new EventEmitter2()

  constructor(
    private baseDir: string,
    private diskDriver: DiskStorageDriver,
    private dbDriver: DBStorageDriver,
    private useDbDriver: boolean,
    private cache: ObjectCache,
    private logger: Logger
  ) {
    if (![-1, this.baseDir.length - 1].includes(this.baseDir.indexOf('*'))) {
      throw new Error(`Base directory can only contain '*' at the end of the path`)
    }

    this.isDirectoryGlob = this.baseDir.endsWith('*')
    this.primaryDriver = useDbDriver ? dbDriver : diskDriver
  }

  private normalizeFolderName(rootFolder: string) {
    return forceForwardSlashes(path.join(this.baseDir, rootFolder))
  }

  private normalizeFileName(rootFolder: string, file: string) {
    return forceForwardSlashes(path.join(this.normalizeFolderName(rootFolder), file))
  }

  objectCacheKey = str => `string::${str}`
  bufferCacheKey = str => `buffer::${str}`

  private async _invalidateFile(fileName: string) {
    await this.cache.invalidate(this.objectCacheKey(fileName))
    await this.cache.invalidate(this.bufferCacheKey(fileName))
  }

  async invalidateFile(rootFolder: string, fileName: string): Promise<void> {
    const filePath = this.normalizeFileName(rootFolder, fileName)
    await this._invalidateFile(filePath)
  }

  async ensureDirs(rootFolder: string, directories: string[]): Promise<void> {
    if (!this.useDbDriver) {
      await Promise.mapSeries(directories, d => this.diskDriver.createDir(this.normalizeFileName(rootFolder, d)))
    }
  }

  async upsertFile(rootFolder: string, file: string, content: string | Buffer): Promise<void> {
    if (this.isDirectoryGlob) {
      throw new Error(`Ghost can't read or write under this scope`)
    }

    const fileName = this.normalizeFileName(rootFolder, file)

    if (content.length > MAX_GHOST_FILE_SIZE) {
      throw new Error(`The size of the file ${fileName} is over the 10mb limit`)
    }

    await this.primaryDriver.upsertFile(fileName, content, true)
    this.events.emit('changed', fileName)
    await this._invalidateFile(fileName)
  }

  async upsertFiles(rootFolder: string, content: FileContent[]): Promise<void> {
    await Promise.all(content.map(c => this.upsertFile(rootFolder, c.name, c.content)))
  }

  /** All tracked directories will be synced
   * Directories are tracked by default, unless a `.noghost` file is present in the directory
   */
  async sync() {
    if (!this.useDbDriver) {
      // We don't have to sync anything as we're just using the files from disk
      return
    }

    const paths = await this.diskDriver.discoverTrackableFolders(this.normalizeFolderName('./'))

    const diskRevs = await this.diskDriver.listRevisions(this.baseDir)
    const dbRevs = await this.dbDriver.listRevisions(this.baseDir)
    const syncedRevs = _.intersectionBy(diskRevs, dbRevs, x => `${x.path} | ${x.revision}`)

    await Promise.each(syncedRevs, rev => this.dbDriver.deleteRevision(rev.path, rev.revision))

    if (!(await this.isFullySynced())) {
      const scUrl = `/admin/settings/version`
      this.logger.warn(
        `You have changes on your production environment that aren't synced on your local file system. Visit '${scUrl}' to save changes back to your Source Control.`
      )
      return
    }

    for (const path of paths) {
      const normalizedPath = this.normalizeFolderName(path)
      let currentFiles = await this.dbDriver.directoryListing(normalizedPath)
      let newFiles = await this.diskDriver.directoryListing(normalizedPath)

      if (path === './') {
        currentFiles = currentFiles.filter(x => !x.includes('/'))
        newFiles = newFiles.filter(x => !x.includes('/'))
      }

      // We delete files that have been deleted from disk
      for (const file of _.difference(currentFiles, newFiles)) {
        const filePath = this.normalizeFileName(path, file)
        await this.dbDriver.deleteFile(filePath, false)
      }

      // We now update files in DB by those on the disk
      for (const file of newFiles) {
        const filePath = this.normalizeFileName(path, file)
        const content = await this.diskDriver.readFile(filePath)
        await this.dbDriver.upsertFile(filePath, content, false)
      }
    }
  }

  public async exportToDirectory(directory: string): Promise<string[]> {
    const allFiles = await this.directoryListing('./')

    for (const file of allFiles.filter(x => x !== 'revisions.json')) {
      const content = await this.primaryDriver.readFile(this.normalizeFileName('./', file))
      const outPath = path.join(directory, file)
      mkdirp.sync(path.dirname(outPath))
      await fse.writeFile(outPath, content)
    }

    const oldRevisions = await this.diskDriver.listRevisions(this.baseDir)
    const newRevisions = await this.dbDriver.listRevisions(this.baseDir)
    const mergedRevisions = _.unionBy(oldRevisions, newRevisions, x => x.path + ' ' + x.revision)

    await fse.writeFile(path.join(directory, 'revisions.json'), JSON.stringify(mergedRevisions, undefined, 2))
    if (!allFiles.includes('revisions.json')) {
      allFiles.push('revisions.json')
    }

    return allFiles
  }

  public async isFullySynced(): Promise<boolean> {
    if (!this.useDbDriver) {
      return true
    }

    const revisions = await this.dbDriver.listRevisions(this.baseDir)
    return revisions.length === 0
  }

  async readFileAsBuffer(rootFolder: string, file: string): Promise<Buffer> {
    if (this.isDirectoryGlob) {
      throw new Error(`Ghost can't read or write under this scope`)
    }

    const fileName = this.normalizeFileName(rootFolder, file)
    const cacheKey = this.bufferCacheKey(fileName)

    if (!(await this.cache.has(cacheKey))) {
      const value = await this.primaryDriver.readFile(fileName)
      await this.cache.set(cacheKey, value)
      return value
    }

    return this.cache.get<Buffer>(cacheKey)
  }

  async readFileAsString(rootFolder: string, file: string): Promise<string> {
    return (await this.readFileAsBuffer(rootFolder, file)).toString()
  }

  async readFileAsObject<T>(rootFolder: string, file: string): Promise<T> {
    const fileName = this.normalizeFileName(rootFolder, file)
    const cacheKey = this.objectCacheKey(fileName)

    if (!(await this.cache.has(cacheKey))) {
      const value = await this.readFileAsString(rootFolder, file)
      const obj = <T>JSON.parse(value)
      await this.cache.set(cacheKey, obj)
      return obj
    }

    return this.cache.get<T>(cacheKey)
  }

  async fileExists(rootFolder: string, file: string): Promise<boolean> {
    const fileName = this.normalizeFileName(rootFolder, file)
    try {
      await this.primaryDriver.readFile(fileName)
      return true
    } catch (err) {
      return false
    }
  }

  async deleteFile(rootFolder: string, file: string): Promise<void> {
    if (this.isDirectoryGlob) {
      throw new Error(`Ghost can't read or write under this scope`)
    }

    const fileName = this.normalizeFileName(rootFolder, file)
    await this.primaryDriver.deleteFile(fileName, true)
    this.events.emit('changed', fileName)
    await this._invalidateFile(fileName)
  }

  async deleteFolder(folder: string): Promise<void> {
    if (this.isDirectoryGlob) {
      throw new Error(`Ghost can't read or write under this scope`)
    }

    const folderName = this.normalizeFolderName(folder)
    await this.primaryDriver.deleteDir(folderName)
  }

  async directoryListing(
    rootFolder: string,
    fileEndingPattern: string = '*.*',
    exludes?: string | string[]
  ): Promise<string[]> {
    try {
      const files = await this.primaryDriver.directoryListing(this.normalizeFolderName(rootFolder), exludes)
      return (files || []).filter(
        minimatch.filter(fileEndingPattern, { matchBase: true, nocase: true, noglobstar: false })
      )
    } catch (err) {
      if (err && err.message && err.message.includes('ENOENT')) {
        return []
      }
      throw new VError(err, `Could not list directory under ${rootFolder}`)
    }
  }

  async getPendingChanges(): Promise<PendingRevisions> {
    if (!this.useDbDriver) {
      return {}
    }

    const revisions = await this.dbDriver.listRevisions(this.baseDir)
    const result: PendingRevisions = {}

    for (const revision of revisions) {
      const rPath = path.relative(this.baseDir, revision.path)
      const folder = rPath.includes(path.sep) ? rPath.substr(0, rPath.indexOf(path.sep)) : 'root'

      if (!result[folder]) {
        result[folder] = []
      }

      result[folder].push(revision)
    }

    return result
  }

  onFileChanged(callback: (filePath: string) => void): ListenHandle {
    const cb = file => callback && callback(file)
    this.events.on('changed', cb)
    return { remove: () => this.events.off('changed', cb) }
  }
}
