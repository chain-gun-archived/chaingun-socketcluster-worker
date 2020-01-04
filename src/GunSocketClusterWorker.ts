import { createServer } from '@chaingun/http-server'
import createAdapter from '@chaingun/node-adapters'
import { pseudoRandomText, verify } from '@chaingun/sear'
import { GunGraphAdapter, GunGraphData, GunMsg, GunNode } from '@chaingun/types'
import express from 'express'
import morgan from 'morgan'
import healthChecker from 'sc-framework-health-check'
import { SCServerSocket } from 'socketcluster-server'
// tslint:disable-next-line: no-submodule-imports
import SCWorker from 'socketcluster/scworker'

export class GunSocketClusterWorker extends SCWorker {
  public readonly adapter: GunGraphAdapter

  constructor(...args) {
    super(...args)
    this.adapter = this.wrapAdapter(this.setupAdapter())
  }

  public run(): void {
    this.httpServer.on('request', this.setupExpress())
    this.setupMiddleware()
  }

  public isAdmin(socket: SCServerSocket): boolean {
    return (
      socket.authToken && socket.authToken.pub === process.env.GUN_OWNER_PUB
    )
  }

  /**
   * Persist put data and publish any resulting diff
   *
   * @param msg
   */
  public async processPut(msg: GunMsg): Promise<GunMsg> {
    const msgId = pseudoRandomText()

    try {
      if (msg.put) {
        await this.adapter.put(msg.put)
      }

      return {
        '#': msgId,
        '@': msg['#'],
        err: null,
        ok: true
      }
    } catch (e) {
      return {
        '#': msgId,
        '@': msg['#'],
        err: 'Error saving',
        ok: false
      }
    }
  }

  public readNode(soul: string): Promise<GunNode | null> {
    return this.adapter.get(soul)
  }

  protected wrapAdapter(adapter: GunGraphAdapter): GunGraphAdapter {
    return {
      get: adapter.get,
      getJsonString: adapter.getJsonString,
      getJsonStringSync: adapter.getJsonStringSync,
      put: (graphData: GunGraphData) => {
        return adapter.put(graphData).then(diff => {
          if (!diff || !Object.keys(diff).length) {
            return diff
          }

          this.publishDiff({
            '#': pseudoRandomText(),
            put: diff
          })

          return diff
        })
      }
    }
  }

  protected setupAdapter(): GunGraphAdapter {
    return createAdapter()
  }

  protected setupExpress(): express.Application {
    const environment = this.options.environment
    const app = createServer(this.adapter)

    if (environment === 'dev') {
      // Log every HTTP request.
      // See https://github.com/expressjs/morgan for other available formats.
      app.use(morgan('dev'))
    }

    // Listen for HTTP GET "/health-check".
    healthChecker.attach(this, app)
    return app
  }

  protected setupMiddleware(): void {
    this.scServer.addMiddleware(
      this.scServer.MIDDLEWARE_SUBSCRIBE,
      this.subscribeMiddleware.bind(this)
    )

    this.scServer.addMiddleware(
      this.scServer.MIDDLEWARE_PUBLISH_IN,
      this.publishInMiddleware.bind(this)
    )

    this.scServer.on('connection', socket => {
      socket.on('login', (req, respond) =>
        this.authenticateLogin(socket, req, respond)
      )
    })
  }

  /**
   * Authenticate a connection for extra privileges
   *
   * @param req
   */
  protected async authenticateLogin(
    socket: SCServerSocket,
    req: {
      readonly pub: string
      readonly proof: {
        readonly m: string
        readonly s: string
      }
    },
    respond: {
      (arg0: null, arg1: string): void
      (arg0?: Error): void
      (arg0: null, arg1: string): void
    }
  ): Promise<void> {
    if (!req.pub || !req.proof) {
      respond(null, 'Missing login info')
      return
    }

    try {
      const [socketId, timestampStr] = req.proof.m.split('/')
      const timestamp = parseInt(timestampStr, 10)
      const now = new Date().getTime()
      const drift = Math.abs(now - timestamp)
      const maxDrift =
        (process.env.SC_AUTH_MAX_DRIFT &&
          parseInt(process.env.SC_AUTH_MAX_DRIFT, 10)) ||
        1000 * 60 * 5

      if (drift > maxDrift) {
        respond(new Error('Exceeded max clock drift'))
        return
      }

      if (!socketId || socketId !== socket.id) {
        respond(new Error("Socket ID doesn't match"))
        return
      }

      const isVerified = await verify(req.proof, req.pub)

      if (isVerified) {
        socket.setAuthToken({
          pub: req.pub,
          timestamp
        })
        respond()
      } else {
        respond(null, 'Invalid login')
      }
    } catch (err) {
      respond(null, 'Invalid login')
    }
  }

  protected subscribeMiddleware(req: any, next: (arg0?: Error) => void): void {
    if (req.channel === 'gun/put' || req.channel === 'gun/get') {
      if (!this.isAdmin(req.socket)) {
        next(new Error(`You aren't allowed to subscribe to ${req.channel}`))
        return
      }
    }

    const soul = req.channel.replace(/^gun\/nodes\//, '')

    if (!soul || soul === req.channel) {
      next()
      return
    }

    next()

    const msgId = Math.random()
      .toString(36)
      .slice(2)

    this.readNode(soul)
      .then(node => ({
        channel: req.channel,
        data: {
          '#': msgId,
          put: node
            ? {
                [soul]: node
              }
            : null
        }
      }))
      .catch(e => {
        // tslint:disable-next-line: no-console
        console.warn(e.stack || e)
        return {
          channel: req.channel,
          data: {
            '#': msgId,
            '@': req['#'],
            err: 'Error fetching node'
          }
        }
      })
      .then(msg => {
        setTimeout(() => {
          // Not sure why this delay is necessary and it really shouldn't be
          // Only thing I can figure is if we don't wait we emit before subscribed
          req.socket.emit('#publish', msg)
        }, 25)
      })
  }

  protected publishInMiddleware(
    req: any,
    next: (arg0?: Error | boolean) => void
  ): void {
    const msg = req.data

    if (req.channel !== 'gun/put') {
      if (this.isAdmin(req.socket)) {
        next()
      } else {
        next(new Error("You aren't allowed to write to this channel"))
      }
      return
    }

    next()

    if (req.channel !== 'gun/put' || !msg || !msg.put) {
      return
    }

    this.processPut(msg).then(data => {
      req.socket.emit('#publish', {
        channel: `gun/@${msg['#']}`,
        data
      })
    })
  }

  /**
   * Send put data to node subscribers as a diff
   *
   * @param msg
   */
  protected publishDiff(msg: GunMsg): void {
    const msgId = msg['#']
    const diff = msg.put

    if (!diff) {
      return
    }

    const exchange = this.scServer.exchange

    for (const soul in diff) {
      if (!soul) {
        continue
      }

      const nodeDiff = diff[soul]

      if (!nodeDiff) {
        continue
      }

      exchange.publish(`gun/nodes/${soul}`, {
        '#': `${msgId}/${soul}`,
        put: {
          [soul]: nodeDiff
        }
      })
    }

    exchange.publish('gun/put/diff', msg)
  }
}
