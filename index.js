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
    console.error(error)
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

const getWorkstream = async (workstreamId) => {
  try {
    const db = getFirestore()
    const snapshot = await db.collection('tasks').doc(workstreamId).get();
    const workstream = snapshot.data()
    return workstream
  } catch (error) {
    console.error(error)
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

const updateProposal = async (proposalUri, data) => {
  const db = getFirestore()
  const proposalId = db.collection("proposals").doc(proposalUri);
  await proposalId.update(data);
}

const announceProposal = async (proposal, guildSettings) => {
  const guild = client.guilds.cache.get(guildSettings.guildId)
  const announcementsChannel = await guild.channels.fetch(guildSettings.announcementsChannelId)

  const proposalLink = `https://newsroom.xyz/rooms/${proposal.room}/proposals/${proposal.proposalId}`
  const msg = await announcementsChannel.send(`💡 New proposal: **${proposal.title} (${proposal.amount} MATIC)**
${proposalLink}

React with a 🚀 to vote in favor for this proposal.`)

  updateProposal(proposal.uri, { discordMessageId: msg.id })
}

const announceWorkstreamApplication = async (proposal, guildSettings) => {
  const workstream = await getWorkstream(proposal.workstreamId)
  const guild = client.guilds.cache.get(guildSettings.guildId)
  let workstreamChannel;

  if (!workstream.discordChannelName && !workstream.discordChannelId) return

  if (workstream.discordChannelId) {
    workstreamChannel = guild.channels.cache.get(workstream.discordChannelId)
  } else {
    workstreamChannel = guild.channels.cache.find(channel => channel.name === workstream.discordChannelName)
  }
  console.log(workstreamChannel)

  if (!workstreamChannel) return

  const proposalLink = `https://newsroom.xyz/rooms/${proposal.room}/proposals/${proposal.proposalId}`
  const msg = await workstreamChannel.send(`🤺 **${proposal.author}** applied for this task!
${proposalLink}

React with a 🚀 to vote in favor.`)

  updateProposal(proposal.uri, { discordMessageId: msg.id })
}

const onNewProposal = async (proposal) => {
  const guildSettings = await getRoomGuildSettings(proposal.room)

  // Abort if room doesn't have any guild configured
  if (!guildSettings) {
    console.log(proposal.room, "proposal", proposal.uri, "was unable to fetch guild settings")
    return
  }

  // Abort if proposal is already announced
  if (proposal.discordMessageId) {
    console.log(proposal.room, "proposal", proposal.uri, "is already announced")
    return
  }

  /* Disable proposal applications for now

  if (proposal.workstreamId) {
    announceWorkstreamApplication(proposal, guildSettings)
  } else {
    announceProposal(proposal, guildSettings)
  }
  */

  // Announce all proposals in the "new-tasks" channel. Even if it's application for a task
  announceProposal(proposal, guildSettings)
}

const onNewTask = async (task) => {
  let guildSettings = await getRoomGuildSettings(task.room)

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
    //discordChannelId: taskChannel.id,
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
  const newsroomCategory = await guild.channels.create(`${room.title} room`, { type: Constants.ChannelTypes.GUILD_CATEGORY })
  console.log(room.id, "create newsroom category", newsroomCategory.id)

  // Create the annoucements channel
  const annoucementsChannel = await newsroomCategory.createChannel("new-tasks-and-proposals", { type: Constants.ChannelTypes.GUILD_TEXT })
  console.log(room.id, "create annoucements channel", annoucementsChannel.id)

  // Post first message
  annoucementsChannel.send(`:new: All new ${room.title} tasks and proposals will be announced here.`)

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
    .where('verified', '==', true)
    .onSnapshot((querySnapshot) => {
      querySnapshot.docChanges().forEach(change => {
        if (change.type !== "added") {
          return;
        }

        try {
          const proposal = { uri: change.doc.id, ...change.doc.data() }
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
    //onCommandNewTask(message, args)
  }
})

client.login(process.env.DISCORD_TOKEN);
