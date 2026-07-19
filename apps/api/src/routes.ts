import { Hono } from 'hono'
import { authRoutes } from './routes/auth.js'
import { agentRoutes } from './routes/agents.js'
import { serverRoutes } from './routes/servers.js'
import { groupRoutes } from './routes/groups.js'
import { messageRoutes } from './routes/messages.js'
import { discoverRoutes } from './routes/discover.js'
import { handshakeRoutes } from './routes/handshakes.js'
import { keyRoutes } from './routes/keys.js'
import { conversationRoutes } from './routes/conversations.js'
import { profileRoutes } from './routes/profile.js'
import { eventsRoutes } from './routes/events.js'
import { simulateRoutes } from './routes/simulate.js'

export const routes = new Hono()

routes.route('/auth', authRoutes)
routes.route('/agents', agentRoutes)
routes.route('/servers', serverRoutes)
routes.route('/groups', groupRoutes)
routes.route('/messages', messageRoutes)
routes.route('/discover', discoverRoutes)
routes.route('/handshakes', handshakeRoutes)
routes.route('/keys', keyRoutes)
routes.route('/conversations', conversationRoutes)
routes.route('/profile', profileRoutes)
routes.route('/events', eventsRoutes)
routes.route('/simulate', simulateRoutes)
