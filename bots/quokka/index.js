const Discord = require("discord.js")
const { google } = require('googleapis')
const fs = require('fs')
const readline = require('readline');
const moment = require('moment')
const client = new Discord.Client()

const Credentials = require('../../entities/Credentials')
const Project = require('../../entities/Project')

const EventManager = require('../../helpers/EventManager')
const EmbedManager = require('../../helpers/EmbedManager')

module.exports = class Quokka {
    constructor () {
        this.$props = {
            eventManager: new EventManager(),
            client: client,
            server: null,
            drive: null,
            driveActivity: null,
            people: null,
            rootFolder: null
        }

        this.$state = {
            oAuth2Client: null
        }

        this.$props.client.login(process.env.QUOKKA_TOKEN)
        this.$props.client.on('ready', () => this.init())
    }

    async init () {
        this.$props.server = this.$props.client.guilds.cache.find(server => server.name === process.env.SERVER)
        
        await this.authenticate()
        console.log(`Logged in as ${this.$props.client.user.tag}!`)
        
        const results = await this.$props.drive.files.list({
            q: `mimeType="application/vnd.google-apps.folder" and name="antiswipe"`
        })

        this.$props.rootFolder = results.data.files[0].id
        this.$state.projects = await Project.find()

        this.initEvents()
    }

    initEvents () {
        this.$props.eventManager.addListener({
            id: 'init',
            event: 'message',
            target: this.$props.client,
            action: (message) => this.onMessage(message)
        })

        setInterval(async () => {
            this.$state.projects.forEach(project => {
                this.getReport(project.name)
            })
        }, 3600000)
    }

    onMessage (message) {
        if (message.content == '!project') this.displayInfo(message)
        if (message.content == '!project-create')this.createProject(message)
        if (message.content == '!project-report') this.getReport(message.channel.name, true)
    }

    async getReport (name, force = false) {
        const project = await Project.findOne({ name: name })
        if (!project) return

        const channel = this.$props.server.channels.cache.find(c => c.id == project.channelId)
        const embed = new EmbedManager({
            title: `Rapport d'activité`
        })

        const results = await this.$props.drive.files.list({
            q: `'${project.folderId}' in parents`
        })

        if (results.data.files.length > 0) {
            let activities = await Promise.all(results.data.files.map(result => {
                return new Promise(async resolve => {
                    let activities = []
    
                    const file = await this.$props.drive.files.get({
                        fileId: result.id,
                        fields: 'name, webViewLink'
                    })
                
                    const activitiesResults = await this.$props.driveActivity.activity.query({
                        itemName: `items/${result.id}`,
                        filter: force ? `` : `time > "${moment(project.lastModifications).format()}"`,
                        pageSize: 5
                    })
    
                    const getTimeInfo = function (activity) {
                        if ('timestamp' in activity) return new Date(activity.timestamp)
                        if ('timeRange' in activity) return new Date(activity.timeRange.endTime)
                        return 'unknown'
                    }
                    
                    if (activitiesResults.data.activities) {
                        activitiesResults.data.activities.forEach(activity => {
                            let action = activity.primaryActionDetail
    
                            if (action.edit || action.create || action.delete) {
                                let type = null
    
                                if (action.edit) type = '🔧 Modification'
                                if (action.create) type = '💡 Création'
                                if (action.delete) type = '❌ Suppression'
    
                                activities.push({
                                    type: type,
                                    name: file.data.name,
                                    link: file.data.webViewLink,
                                    time: getTimeInfo(activity)
                                })
                            }
                        })
                    }
    
                    resolve(activities)
                })
            }))
    
            activities = [].concat.apply([], activities).sort((a, b) => new Date(b.date) - new Date(a.date))
    
            if (activities.length > 0) {
                activities.forEach((activity, i) => {
                    embed.addField(activity.name + i, {
                        title: `${moment(activity.time).format('h:mm (Do MMMM YYYY)')}`,
                        description: `${activity.type} du fichier [${activity.name}](${activity.link}).`
                    })
                })
    
                await Project.updateOne({ _id: project._id }, {
                    lastModifications: new Date()
                })
    
                embed.sendTo(channel)
            }
        }
    }

    async createProject (message) {
        const name = message.channel.name
        let project = await Project.findOne({ name })

        if (project) {
            message.reply('Ce projet existe déjà.')
        } else {
            let folderExists = false
            let folder = null
            let mainFolderSearch = await this.$props.drive.files.list({
                q: `mimeType="application/vnd.google-apps.folder" and name="${name}" and "${this.$props.rootFolder}" in parents`
            })

            folderExists = mainFolderSearch.data.files.length > 0

            if (folderExists) {
                console.log('Folder already exists.')
                folder = mainFolderSearch.data.files[0]
            } else {
                console.log('Creating new folder !')
                folder = await this.$props.drive.files.create({
                    resource: {
                        'name': name,
                        parents: [this.$props.rootFolder],
                        'mimeType': 'application/vnd.google-apps.folder'
                    }
                })

                folder = folder.data
            }

            if (folder) {
                const mainFile = await this.$props.drive.files.create({
                    resource: {
                        name: name,
                        parents: [folder.id],
                        mimeType: 'application/vnd.google-apps.document',
                    }
                })

                project = await Project.create({
                    name,
                    channelId: message.channel.id,
                    folderId: folder.id
                })

                this.displayInfo(message)
            }
        }
    }

    async displayInfo (message) {
        const channel = message.channel
        const embed = new EmbedManager({
            title: channel.name
        })

        let mainFileSearch = await this.$props.drive.files.list({
            q: `mimeType="application/vnd.google-apps.document" and name="${channel.name}"`
        })

        let mainFolderSearch = await this.$props.drive.files.list({
            q: `mimeType="application/vnd.google-apps.folder" and name="${channel.name}"`
        })

        if (mainFileSearch.data.files.length > 0 && mainFolderSearch.data.files.length > 0) {
            let mainFile = await this.$props.drive.files.get({
                fileId: mainFileSearch.data.files[0].id,
                fields: 'webViewLink'
            })

            let mainFolder = await this.$props.drive.files.get({
                fileId: mainFolderSearch.data.files[0].id,
                fields: 'webViewLink'
            })

            embed.addFields({
                mainFolder: {
                    title: 'Dossier :',
                    description: mainFolder.data.webViewLink
                },
                mainFile: {
                    title: 'Fichier principal :',
                    description: mainFile.data.webViewLink
                }
            })

            embed.sendTo(channel)
        } else {
            message.reply(`on dirait que ce projet n'existe pas encore.`)
        }
    }

    authenticate () {
        return new Promise (async resolve => {
            const stored = await Credentials.findOne({ name: 'google-drive' })
            this.$state.oAuth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT);
        
            if (stored) {
                await this.$state.oAuth2Client.setCredentials(JSON.parse(stored.content))
            } else {
                await this.createNewToken()
            }

            this.$props.drive = google.drive({ version: 'v3', auth: this.$state.oAuth2Client })
            this.$props.driveActivity = google.driveactivity({version: 'v2', auth: this.$state.oAuth2Client })
            this.$props.people = google.people('v1')

            resolve(true)
        })
    }

    createNewToken () {
        return new Promise (resolve => {
            const authUrl = this.$state.oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/drive.activity', 'https://www.googleapis.com/auth/contacts'] });
            console.log('Authorize this app by visiting this url:', authUrl);
            
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
            })

            rl.question('Enter the code from that page here: ', (code) => {
                rl.close();

                this.$state.oAuth2Client.getToken(code, async (err, token) => {
                    if (err) return console.error('Error retrieving access token', err);
                    this.$state.oAuth2Client.setCredentials(token);

                    await Credentials.create({
                        name: 'google-drive',
                        content: JSON.stringify(token)
                    })
                    
                    resolve(true)
                })
            })
        })
    }
}