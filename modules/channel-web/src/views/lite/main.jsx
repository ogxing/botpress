/* global: window */

import React from 'react'
import classnames from 'classnames'

import addMilliseconds from 'date-fns/add_milliseconds'
import isBefore from 'date-fns/is_before'
import queryString from 'query-string'
import ms from 'ms'

import Convo from './convo'
import Side from './side'

import style from './style.scss'
import asyncDebounce from './async-debounce'

const _values = obj => Object.keys(obj).map(x => obj[x])

if (!window.location.origin) {
  window.location.origin =
    window.location.protocol +
    '//' +
    window.location.hostname +
    (window.location.port ? ':' + window.location.port : '')
}

const ANIM_DURATION = 300

const MIN_TIME_BETWEEN_SOUNDS = 10000 // 10 seconds

const HISTORY_STARTING_POINT = -1
const HISTORY_MAX_MESSAGES = 10
const HISTORY_UP = 'ArrowUp'

const defaultOptions = {
  locale: 'en-US',
  botName: 'Bot',
  backgroundColor: '#ffffff',
  textColorOnBackground: '#666666',
  foregroundColor: '#000000',
  textColorOnForeground: '#ffffff',
  enableReset: false,
  extraStylesheet: '',
  showConversationsButton: true,
  showUserName: false,
  showUserAvatar: false,
  enableTranscriptDownload: false,
  enableArrowNavigation: false
}

export default class Web extends React.Component {
  constructor(props) {
    super(props)

    if (window.botpressWebChat && window.botpressWebChat.sendUsageStats) {
      ReactGA.initialize('UA-90044826-2')
      ReactGA.event({ category: 'WebChat', action: 'render', nonInteraction: true })
    }

    this.quickReplyDebounce = asyncDebounce(1000)

    const { options } = queryString.parse(location.search)
    const { config } = JSON.parse(decodeURIComponent(options || '{}'))

    if (config.overrides) {
      for (const override of _values(config.overrides)) {
        this.props.bp.loadModuleView(override.module, true)
      }
    }

    this.state = {
      view: null,
      botInfo: null,
      textToSend: '',
      loading: true,
      played: false,
      opened: false,
      config: Object.assign({}, defaultOptions, config),
      conversations: [],
      currentConversation: null,
      currentConversationId: null,
      unreadCount: 0,
      isButtonHidden: config.hideWidget,
      isTransitioning: false,
      messageHistory: [],
      historyPosition: HISTORY_STARTING_POINT
    }

    this.updateAxiosConfig()
  }

  componentWillMount() {
    this.setupSocket()
  }

  componentDidMount() {
    if (this.state.config.userId) {
      this.props.bp.events.updateVisitorId(this.state.config.userId)
    }

    this.setUserId()
      .then(this.fetchData)
      .then(() => {
        this.handleSwitchView('widget')
        if (!this.state.isButtonHidden) {
          this.showConvoPopUp()
        }

        this.setState({ loading: false })
      })

    window.addEventListener('message', this.handleIframeApi)

    this.props.bp.axios.interceptors.request.use(
      config => {
        if (/\/api\/ext\/channel-web\//i.test(config.url)) {
          const prefix = config.url.indexOf('?') > 0 ? '&' : '?'
          config.url += prefix + '__ts=' + new Date().getTime()
        }
        return config
      },
      error => {
        return Promise.reject(error)
      }
    )
  }

  componentWillUnmount() {
    window.removeEventListener('message', this.handleIframeApi)
    this.isUnmounted = true
  }

  updateAxiosConfig() {
    const { botId, externalAuthToken } = this.state.config

    this.axiosConfig = botId
      ? { baseURL: `${window.location.origin}/api/v1/bots/${botId}` }
      : { baseURL: `${window.BOT_API_PATH}` }

    if (externalAuthToken) {
      this.axiosConfig = {
        ...this.axiosConfig,
        headers: {
          ExternalAuth: `Bearer ${externalAuthToken}`
        }
      }
    }
  }

  fetchBotInfo = () => {
    return this.props.bp.axios
      .get('/mod/channel-web/botInfo', this.axiosConfig)
      .then(({ data }) => this.setState({ botInfo: data }))
  }

  changeUserId = newId => {
    this.props.bp.events.updateVisitorId(newId)
    this.setState({ currentConversationId: null })
    this.setUserId().then(this.fetchData)
  }

  sendUserEvent = data => {
    const userId = window.__BP_VISITOR_ID
    const url = `/mod/channel-web/events/${userId}`
    return this.props.bp.axios.post(url, data, this.axiosConfig)
  }

  handleIframeApi = ({ data: { action, payload } }) => {
    if (action === 'configure') {
      if (payload.userId) {
        this.changeUserId(payload.userId)
      }
      this.setState({ config: Object.assign({}, defaultOptions, payload) }, this.updateAxiosConfig)
    } else if (action === 'event') {
      const { type, text } = payload
      if (type === 'show') {
        this.handleSwitchView('side')
      } else if (type === 'hide') {
        this.handleSwitchView('widget')
      } else if (type === 'message') {
        this.setState({ textToSend: text })
        this.handleSendMessage()
      } else {
        return this.sendUserEvent({ type, payload })
      }
    }
  }

  setUserId() {
    return new Promise((resolve, reject) => {
      const interval = setInterval(() => {
        if (window.__BP_VISITOR_ID) {
          clearInterval(interval)
          this.userId = window.__BP_VISITOR_ID
          window.parent.postMessage({ userId: this.userId }, '*')
          resolve()
        }
      }, 250)

      setTimeout(() => {
        clearInterval(interval)
        reject()
      }, 300000)
    })
  }

  showConvoPopUp() {
    if (this.state.config.welcomeMsgEnable) {
      setTimeout(() => {
        if (!this.state.opened) {
          this.handleSwitchView('convo')
        }
      }, this.state.config.welcomeMsgDelay || 5000)
    }
  }

  handleSwitchView(view) {
    if (this.state.isTransitioning) {
      return
    }
    this.setState({ isTransitioning: true })

    if (view === 'side' && this.state.view !== 'side') {
      this.setState({
        opened: true,
        unreadCount: 0,
        convoTransition: 'fadeOut',
        widgetTransition: 'fadeOut'
      })

      setTimeout(() => {
        this.setState({
          sideTransition: 'fadeIn',
          view: view,
          isTransitioning: false
        })
      }, ANIM_DURATION + 10)
    }

    if (view === 'convo') {
      setTimeout(() => {
        this.setState({
          convoTransition: 'fadeIn',
          view: view,
          isTransitioning: false
        })
      }, ANIM_DURATION)
    }

    if (view === 'widget') {
      this.setState({
        convoTransition: 'fadeOut',
        sideTransition: 'fadeOut'
      })

      if (!this.state.view || this.state.view === 'side') {
        setTimeout(() => {
          this.setState({
            widgetTransition: 'fadeIn',
            view: view,
            isTransitioning: false
          })
        }, ANIM_DURATION)
      }
    }

    setTimeout(() => {
      this.setState({
        view: view,
        isTransitioning: false
      })
    }, ANIM_DURATION)

    setTimeout(() => {
      this.setState({
        widgetTransition: null,
        convoTransition: null,
        sideTransition: this.state.sideTransition === 'fadeIn' ? 'fadeIn' : null,
        isTransitioning: false
      })
    }, ANIM_DURATION * 2.1)
  }

  handleButtonClicked = () => {
    if (this.state.view === 'convo') {
      this.handleSwitchView('widget')
    } else {
      this.handleSwitchView('side')
    }
  }

  setupSocket() {
    // Connect the Botpress's Web Socket to the server
    if (this.props.bp && this.props.bp.events) {
      this.props.bp.events.setup()
    }

    this.props.bp.events.on('guest.webchat.message', this.handleNewMessage)
    this.props.bp.events.on('guest.webchat.typing', this.handleBotTyping)
    //firehose events to parent page
    this.props.bp.events.onAny(this.postToParent)
  }

  postToParent = (t, payload) => {
    // we could filter on event type if necessary
    window.parent && window.parent.postMessage(payload)
  }

  checkForExpiredExternalToken = error => {
    if (_.get(error, 'response.data.errorCode') === 'BP_0401') {
      this.setState({ config: { ...this.state.config, externalAuthToken: undefined } }, this.updateAxiosConfig)
      console.log(`External token expired or invalid. Removed from future requests`)
    }
  }

  fetchData = () => {
    return this.fetchBotInfo()
      .then(this.fetchConversations)
      .then(this.fetchCurrentConversation)
      .then(() => {
        this.handleSendData({
          type: 'visit',
          text: 'User visit',
          timezone: new Date().getTimezoneOffset() / 60
        }).catch(this.checkForExpiredExternalToken)
      })
  }

  fetchConversations = () => {
    const axios = this.props.bp.axios
    const userId = this.userId
    const url = `/mod/channel-web/conversations/${userId}`

    return axios
      .get(url, this.axiosConfig)
      .then(({ data }) => new Promise(resolve => !this.isUnmounted && this.setState(data, resolve)))
  }

  fetchCurrentConversation = convoId => {
    const axios = this.props.bp.axios
    const userId = this.userId
    const { conversations, currentConversationId } = this.state

    let conversationIdToFetch = convoId || currentConversationId
    if (conversations.length > 0 && !conversationIdToFetch) {
      const lifeTimeMargin = Date.now() - ms(this.state.recentConversationLifetime)
      if (new Date(conversations[0].last_heard_on).getTime() < lifeTimeMargin && this.state.startNewConvoOnTimeout) {
        return
      }
      conversationIdToFetch = conversations[0].id
      this.setState({ currentConversationId: conversationIdToFetch })
    }

    const url = `/mod/channel-web/conversations/${userId}/${conversationIdToFetch}`

    return axios.get(url, this.axiosConfig).then(({ data }) => {
      // Possible race condition if the current conversation changed while fetching
      if (this.state.currentConversationId !== conversationIdToFetch) {
        // In which case we simply restart fetching
        return this.fetchCurrentConversation()
      }

      this.setState({ currentConversation: data })
    })
  }

  handleNewMessage = event => {
    if (event.message_type === 'visit') {
      // don't do anything, it's the system message
      return
    }
    this.safeUpdateCurrentConvo(event.conversationId, true, convo => {
      return Object.assign({}, convo, {
        messages: [...convo.messages, event],
        typingUntil: event.userId ? convo.typingUntil : null
      })
    })
  }

  handleBotTyping = event => {
    this.safeUpdateCurrentConvo(event.conversationId, false, convo => {
      return Object.assign({}, convo, {
        typingUntil: addMilliseconds(new Date(), event.timeInMs)
      })
    })

    setTimeout(this.expireTyping, event.timeInMs + 50)
  }

  expireTyping = () => {
    const currentTypingUntil = this.state.currentConversation && this.state.currentConversation.typingUntil

    const timerExpired = currentTypingUntil && isBefore(new Date(currentTypingUntil), new Date())
    if (timerExpired) {
      this.safeUpdateCurrentConvo(this.state.currentConversationId, false, convo => {
        return Object.assign({}, convo, { typingUntil: null })
      })
    }
  }

  safeUpdateCurrentConvo(convoId, addToUnread, updater) {
    // there's no conversation to update or our convo changed
    if (!this.state.currentConversation || this.state.currentConversationId != convoId) {
      this.fetchConversations().then(this.fetchCurrentConversation)
      return
    }

    // there's no focus on the actual conversation
    if ((document.hasFocus && !document.hasFocus()) || this.state.view !== 'side') {
      this.playSound()

      if (addToUnread) {
        this.increaseUnreadCount()
      }
    }

    this.handleResetUnreadCount()

    const newConvo = updater && updater(this.state.currentConversation)

    if (newConvo) {
      this.setState({ currentConversation: newConvo })
    }
  }

  playSound() {
    if (!this.state.played && this.state.view !== 'convo') {
      // TODO: Remove this condition (view !== 'convo') and fix transition sounds
      const audio = new Audio('/assets/modules/channel-web/notification.mp3')
      audio.play()

      this.setState({
        played: true
      })

      setTimeout(() => {
        this.setState({
          played: false
        })
      }, MIN_TIME_BETWEEN_SOUNDS)
    }
  }

  increaseUnreadCount() {
    this.setState({
      unreadCount: this.state.unreadCount + 1
    })
  }

  handleResetUnreadCount = () => {
    if (document.hasFocus && document.hasFocus() && this.state.view === 'side') {
      this.setState({
        unreadCount: 0
      })
    }
  }

  handleSendMessage = () => {
    if (!this.state.textToSend || !this.state.textToSend.length) {
      return
    }

    this.setState({
      messageHistory: _.take([this.state.textToSend, ...this.state.messageHistory], HISTORY_MAX_MESSAGES),
      historyPosition: HISTORY_STARTING_POINT
    })

    return this.handleSendData({ type: 'text', text: this.state.textToSend }).then(() => {
      this.handleSwitchView('side')
      this.setState({ textToSend: '' })
    })
  }

  handleRecallHistory = direction => {
    const position = direction === HISTORY_UP ? this.state.historyPosition + 1 : this.state.historyPosition - 1
    const text = _.nth(this.state.messageHistory, position)
    text && this.setState({ textToSend: text, historyPosition: position })
  }

  handleTextChanged = event => {
    this.setState({
      textToSend: event.target.value
    })
  }

  handleAddEmoji = emoji => {
    this.setState({
      textToSend: this.state.textToSend + emoji.native + ' '
    })
  }

  handleSendQuickReply = (title, payload) => {
    const promise = this.handleSendData({
      type: 'quick_reply',
      text: title,
      data: { payload }
    })

    return this.quickReplyDebounce.debounce(promise)
  }

  handleSendForm = (fields, formId, repr) => {
    return this.handleSendData({
      type: 'form',
      formId: formId,
      text: repr,
      data: fields
    })
  }

  handleLoginPrompt = (username, password) => {
    return this.handleSendData({
      type: 'login_prompt',
      text: 'Provided login information',
      data: { username, password }
    })
  }

  handleFileUploadSend = (title, payload, file) => {
    const userId = window.__BP_VISITOR_ID
    const url = `/mod/channel-web/messages/${userId}/files`
    const config = { params: { conversationId: this.state.currentConversationId }, ...this.axiosConfig }

    const data = new FormData()
    data.append('file', file)

    return this.props.bp.axios.post(url, data, config).then()
  }

  handleSendData = data => {
    const userId = window.__BP_VISITOR_ID
    const url = `/mod/channel-web/messages/${userId}`
    const config = { params: { conversationId: this.state.currentConversationId }, ...this.axiosConfig }

    return this.props.bp.axios
      .post(url, data, config)
      .then()
      .catch(this.checkForExpiredExternalToken)
  }

  handleSwitchConvo = convoId => {
    this.setState({
      currentConversation: null,
      currentConversationId: convoId
    })

    this.fetchCurrentConversation(convoId)
  }

  handleClosePanel = () => {
    this.handleSwitchView('widget')
  }

  handleSessionReset = () => {
    const userId = window.__BP_VISITOR_ID
    const url = `/mod/channel-web/conversations/${userId}/${this.state.currentConversationId}/reset`
    return this.props.bp.axios.post(url, {}, this.axiosConfig).then()
  }

  renderOpenIcon() {
    return (
      <svg width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M4.583 14.894l-3.256 3.78c-.7.813-1.26.598-1.25-.46a10689.413 10689.413 0 0 1 .035-4.775V4.816a3.89 3.89 0 0 1 3.88-3.89h12.064a3.885 3.885 0 0 1 3.882 3.89v6.185a3.89 3.89 0 0 1-3.882 3.89H4.583z"
          fill="#FFF"
          fillRule="evenodd"
        />
      </svg>
    )
  }

  renderCloseIcon() {
    return (
      <svg width="17" height="17" viewBox="0 0 17 17" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M16.726 15.402c.365.366.365.96 0 1.324-.178.178-.416.274-.663.274-.246 0-.484-.096-.663-.274L8.323 9.648h.353L1.6 16.726c-.177.178-.416.274-.663.274-.246 0-.484-.096-.663-.274-.365-.365-.365-.958 0-1.324L7.35 8.324v.35L.275 1.6C-.09 1.233-.09.64.274.274c.367-.365.96-.365 1.326 0l7.076 7.078h-.353L15.4.274c.366-.365.96-.365 1.326 0 .365.366.365.958 0 1.324L9.65 8.675v-.35l7.076 7.077z"
          fill="#FFF"
          fillRule="evenodd"
        />
      </svg>
    )
  }

  renderUncountMessages() {
    return <span className={classnames('bp-unread-count', style.unread)}>{this.state.unreadCount}</span>
  }

  renderButton() {
    if (this.state.isButtonHidden) {
      return null
    }
    return (
      <button
        className={classnames('bp-widget-btn', style[this.state.widgetTransition], style.floatingButton)}
        onClick={this.handleButtonClicked}
        style={{ backgroundColor: this.state.config.foregroundColor }}
      >
        <i>{this.state.view === 'convo' ? this.renderCloseIcon() : this.renderOpenIcon()}</i>
        {this.state.unreadCount > 0 ? this.renderUncountMessages() : null}
      </button>
    )
  }

  createConversation = () => {
    const userId = window.__BP_VISITOR_ID
    const url = `/mod/channel-web/conversations/${userId}/new`

    // TODO here we might we might want switch convo with the newly created conversation (need to return the convo ID in BE)
    return this.props.bp.axios.post(url, {}, this.axiosConfig).then(this.fetchConversations)
  }

  renderWidget() {
    return (
      <div className={classnames(style['container'])}>
        <div className={classnames(style['widget-container'])}>
          <span>
            {this.state.view === 'convo' ? (
              <Convo
                botInfo={this.state.botInfo}
                transition={this.state.convoTransition}
                change={this.handleTextChanged}
                send={this.handleSendMessage}
                config={this.state.config}
                text={this.state.textToSend}
              />
            ) : null}
            {this.renderButton()}
          </span>
        </div>
      </div>
    )
  }

  downaloadFile(name, blob) {
    const url = window.URL.createObjectURL(blob)
    const link = document.createElement('a')

    link.href = url
    link.setAttribute('download', name)

    document.body.appendChild(link)
    link.click()

    document.body.removeChild(link)
    window.URL.revokeObjectURL(url)
  }

  downloadConversation = async () => {
    const userId = window.__BP_VISITOR_ID
    const url = `/mod/channel-web/conversations/${userId}/${this.state.currentConversationId}/download/txt`
    const file = (await this.props.bp.axios.get(url, this.axiosConfig)).data
    const blobFile = new Blob([file.txt])

    this.downaloadFile(file.name, blobFile)
  }

  startConversation = cb => {
    return this.sendUserEvent({ payload: { type: 'request_start_conversation' } }).then(cb)
  }

  renderSide() {
    return (
      <Side
        bp={this.props.bp}
        config={this.state.config}
        text={this.state.textToSend}
        fullscreen={this.props.fullscreen}
        transition={!this.props.fullscreen ? this.state.sideTransition : null}
        unreadCount={this.state.unreadCount}
        currentConversation={this.state.currentConversation}
        conversations={this.state.conversations}
        addEmojiToText={this.handleAddEmoji}
        onClose={!this.props.fullscreen ? this.handleClosePanel : null}
        onResetSession={this.handleSessionReset}
        onSwitchConvo={this.handleSwitchConvo}
        onTextSend={this.handleSendMessage}
        recallHistory={this.handleRecallHistory}
        onTextChanged={this.handleTextChanged}
        onQuickReplySend={this.handleSendQuickReply}
        onFormSend={this.handleSendForm}
        onFileUploadSend={this.handleFileUploadSend}
        onLoginPromptSend={this.handleLoginPrompt}
        onSendData={this.handleSendData}
        downloadConversation={this.downloadConversation}
        createConversation={this.createConversation}
        startConversation={this.startConversation}
        botInfo={this.state.botInfo}
      />
    )
  }

  render() {
    if (this.state.loading || !this.state.view) {
      return null
    }

    window.parent &&
      window.parent.postMessage({ type: 'setClass', value: 'bp-widget-web bp-widget-' + this.state.view }, '*')

    const stylesheet = this.state.config.extraStylesheet
    const view = this.state.view !== 'side' && !this.props.fullscreen ? this.renderWidget() : this.renderSide()

    return (
      <div className={classnames('bp-chat', style.web)} onFocus={this.handleResetUnreadCount}>
        {stylesheet && stylesheet.length && <link rel="stylesheet" type="text/css" href={stylesheet} />}
        {view}
      </div>
    )
  }
}
