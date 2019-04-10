import { FlowGeneratorMetadata, Logger } from 'botpress/sdk'
import AuthService, { TOKEN_AUDIENCE } from 'core/services/auth/auth-service'
import { RequestHandler, Router } from 'express'

import { ModuleLoader } from '../module-loader'
import { SkillService } from '../services/dialog/skill/service'

import { CustomRouter } from './customRouter'
import { checkTokenHeader } from './util'

export class ModulesRouter extends CustomRouter {
  private checkTokenHeader!: RequestHandler

  constructor(
    logger: Logger,
    private authService: AuthService,
    private moduleLoader: ModuleLoader,
    private skillService: SkillService
  ) {
    super('Modules', logger, Router({ mergeParams: true }))
    this.checkTokenHeader = checkTokenHeader(this.authService, TOKEN_AUDIENCE)
    this.setupRoutes()
  }

  private setupRoutes(): void {
    this.router.get('/', (req, res) => {
      res.json(this.moduleLoader.getLoadedModules())
    })

    this.router.get(
      '/botTemplates',
      this.checkTokenHeader,
      this.asyncMiddleware(async (req, res, next) => {
        res.send(await this.moduleLoader.getBotTemplates())
      })
    )

    this.router.get(
      '/skills',
      this.checkTokenHeader,
      this.asyncMiddleware(async (req, res, next) => {
        res.send(await this.moduleLoader.getAllSkills())
      })
    )

    this.router.post(
      '/:moduleName/skill/:skillId/generateFlow',
      this.checkTokenHeader,
      this.asyncMiddleware(async (req, res) => {
        const flowGenerator = this.moduleLoader.getFlowGenerator(req.params.moduleName, req.params.skillId)
        if (!flowGenerator) {
          return res.status(404).send('Invalid module name or flow name')
        }

        try {
          const metadata: FlowGeneratorMetadata = { botId: req.query.botId }
          res.send(this.skillService.finalizeFlow(await flowGenerator(req.body, metadata)))
        } catch (err) {
          res.status(400).send(`Error while trying to generate the flow: ${err}`)
        }
      })
    )
  }
}
