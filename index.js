require('dotenv').config()

const { Client, Intents, Constants } = require('discord.js');
const admin = require("firebase-admin");
const slugify = require('slugify');

const { getFirestore } = require("firebase-admin/firestore");

const client = new Client({ intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES] });
const prefix = '!'

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    privateKey: process.env.FIREBASE_PRIVATE_KEY,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL
  }),
});

const getRoomGuildSettings = async (roomName) => {
  try {
    const db = getFirestore()
    const roomDoc = await db.collection('rooms').doc(roomName).get();
    const roomData = roomDoc.data()

    if (!roomData?.discordGuildId || !roomData?.discordAnnouncementsChannelId || !roomData?.discordNewsroomCategoryChannelId) {
      return null
    }

    return {
      guildId: roomData.discordGuildId,
      announcementsChannelId: roomData.discordAnnouncementsChannelId,
      newsroomCategoryChannelId: roomData.discordNewsroomCategoryChannelId,
      prependRoomName: false
    }
  } catch (error) {
    return null
  }
}

const getRoomByGuildId = async (channelId) => {
  try {
    const db = getFirestore()
    const snapshot = await db.collection('rooms').where('discordGuildId', '==', channelId).get();
    const docs = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
    return docs.shift()
  } catch (error) {
    console.log(error)
    return null
  }
}

const onCommandNewTask = async (message, args) => {
  const room = await getRoomByGuildId(message.guildId)
  console.log(room)

  const title = args.join(' ')
  const url = `https://newsroom.xyz/rooms/${room.id}/post?title=${encodeURIComponent(title)}`

  message.channel.send(
    `Create your task here: ${url}`
  )
}

const onNewProposal = async (proposal) => {
  let guildSettings = await getRoomGuildSettings(proposal.room)

  // Abort if room doesn't have any guild configured
  if (!guildSettings) {
    console.log(proposal.room, "proposal", proposal.id, "was unable to fetch guild settings")
    return
  }

  // Abort if proposal is already announced
  if (proposal.discordMessageId) {
    console.log(proposal.room, "proposal", proposal.id, "is already announced")
    return
  }

  // Get the annoucements channel
  const guild = client.guilds.cache.get(guildSettings.guildId)
  const announcementsChannel = await guild.channels.fetch(guildSettings.announcementsChannelId)

  const msg = await announcementsChannel.send(`💡 A new proposal just dropped:
${proposal.title}
${proposal.amount} MATIC`)

  // Set the discord message id
  const db = getFirestore()
  const proposalId = db.collection("proposals").doc(proposal.id);
  await proposalId.update({ discordMessageId: msg.id });
}

const onNewTask = async (task) => {
  let guildSettings = await getRoomGuildSettings(task.room)

  // Use default guild settings (if it exists) when the room doesn't have guild settings
  if (!guildSettings && process.env.DISCORD_DEFAULT_GUILD) {
    guildSettings = {
      guildId: process.env.DISCORD_DEFAULT_GUILD,
      announcementsChannelId: process.env.DISCORD_DEFAULT_ANNOUCEMENTS_CHANNEL,
      newsroomCategoryChannelId: process.env.DISCORD_DEFAULT_CATEGORY,
      prependRoomName: true
    }
  }

  // Abort if room doesn't have any guild configured
  if (!guildSettings) {
    console.log(task.room, task.id, "was unable to fetch guild settings")
    return
  }

  // Abort if task is a welcome task
  if (task.title.startsWith("__Welcome")) {
    console.log(task.room, task.id, "is a welcome task")
    return
  }

  // Abort if task is already announced
  if (task.discordInviteCode) {
    console.log(task.room, task.id, "is already announced")
    return
  }

  // Get the channels
  const guild = client.guilds.cache.get(guildSettings.guildId)
  const announcementsChannel = await guild.channels.fetch(guildSettings.announcementsChannelId)
  const newsroomCategoryChannel = await guild.channels.fetch(guildSettings.newsroomCategoryChannelId)

  // Task link and channel name
  const taskLink = `https://newsroom.xyz/rooms/${task.room}/${task.id}`
  const taskSlug = slugify(task.title).toLowerCase()
  const taskChannelName = `${guildSettings.prependRoomName ? `${task.room}-` : ''}${taskSlug}`

  // Create a task channel
  const taskChannel = await newsroomCategoryChannel.createChannel(taskChannelName)
  taskChannel.send(
    `**${task.title}**
${taskLink}
`)

  // Create the task announcement
  announcementsChannel.send(
    `📰 New task from ${task.room} just dropped:
${taskLink}
Interested? Send a gm in <#${taskChannel.id}>
`)

  // Create invite to the task
  const invite = await taskChannel.createInvite({ maxAge: 0 });
  const db = getFirestore()
  const taskRef = db.collection("tasks").doc(task.id);
  await taskRef.update({
    discordChannelName: taskChannelName,
    discordInviteCode: invite.code,
  });
}

const onRoomConnection = async (room) => {
  const guildId = room.discordGuildId

  // Abort if it already has an annoucments channel
  if (room.discordAnnouncementsChannelId) {
    console.log(room.id, "already has annoucements channel")
    return
  }

  // Get the guild by id
  const guild = client.guilds.cache.get(guildId);

  // Create the newsroom category
  const newsroomCategory = await guild.channels.create("newsroom", { type: Constants.ChannelTypes.GUILD_CATEGORY })
  console.log(room.id, "create newsroom category", newsroomCategory.id)

  // Create the annoucements channel
  const annoucementsChannel = await newsroomCategory.createChannel("new-tasks", { type: Constants.ChannelTypes.GUILD_TEXT })
  console.log(room.id, "create annoucements channel", annoucementsChannel.id)

  // Post first message
  annoucementsChannel.send(`:new: All new ${room.title} tasks will be announced here.

:question: Use the \`!newtask\` command in this channel to start adding tasks! For example:

> !newtask Write a welcome blog post explaining newsroom.xyz
`)

  // Save the channel ids
  const db = getFirestore()
  const roomRef = db.collection('rooms').doc(room.id);
  await roomRef.update({
    discordAnnouncementsChannelId: annoucementsChannel.id,
    discordNewsroomCategoryChannelId: newsroomCategory.id
  });
}

const listenForNewTasks = () => {
  const start = new Date('Dec 08, 2021 12:00:00 GMT+00:00')
  const db = getFirestore();
  db
    .collection('tasks')
    .where('created', '>', start)
    .onSnapshot((querySnapshot) => {
      querySnapshot.docChanges().forEach(change => {
        if (change.type !== "added") {
          return;
        }

        try {
          const task = { id: change.doc.id, ...change.doc.data() }
          onNewTask(task);
        } catch (error) {
          console.error(error)
        }
      })
    });
}

const listenForNewProposals = () => {
  const start = new Date('Dec 08, 2021 12:00:00 GMT+00:00')
  const db = getFirestore();
  db
    .collection('proposals')
    .where('created', '>', start)
    .onSnapshot((querySnapshot) => {
      querySnapshot.docChanges().forEach(change => {
        if (change.type !== "added") {
          return;
        }

        try {
          const proposal = { id: change.doc.id, ...change.doc.data() }
          onNewProposal(proposal);
        } catch (error) {
          console.error(error)
        }
      })
    });
}

const listenForRoomConnections = () => {
  const db = getFirestore()
  db
    .collection('rooms')
    .where('discordGuildId', '!=', '')
    .onSnapshot((querySnapshot) => {
      querySnapshot.docChanges().forEach(change => {
        // Added in this case means going from no discordGuildId to having one
        if (change.type !== "added") {
          return;
        }

        try {
          const room = { id: change.doc.id, ...change.doc.data() }
          onRoomConnection(room)
        } catch (error) {
          console.error(error)
        }
      })
    });
}

client.once('ready', () => {
  console.log('Ready!');
  listenForNewTasks();
  listenForNewProposals();
  listenForRoomConnections();
});

client.on('messageCreate', async message => {
  if (message.author.bot) return
  if (!message.content.startsWith(prefix)) return

  const args = message.content.slice(prefix.length).trim().split(/ +/g);
  const command = args.shift().toLowerCase();

  if (command === 'newtask') {
    onCommandNewTask(message, args)
  }
})

client.login(process.env.DISCORD_TOKEN);
