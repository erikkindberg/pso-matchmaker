const fs = require('fs')
const path = require('path')
const { Client, Collection, Intents } = require('discord.js');
const dotenv = require('dotenv');
__dirname = path.resolve();

dotenv.config()

process.on('unhandledRejection', error => {
	console.error('Unhandled promise rejection:', error);
});

const client = new Client({
    intents: [
        Intents.FLAGS.GUILDS,
        Intents.FLAGS.GUILD_MESSAGES,
		Intents.FLAGS.GUILD_PRESENCES
    ],
	allowedMentions: {
		parse:  ['roles', 'users', 'everyone'],
		repliedUser: false
	}
})

//Fetch and push commands into the client
client.commands = new Collection()
const commandFiles = fs.readdirSync('./commands').filter(file => file.endsWith('.js'))
for (const file of commandFiles) {
	const command = require(`./commands/${file}`);
	client.commands.set(command.data.name, command);
}

//Fetch and registers all event handlers
const eventFiles = fs.readdirSync('./events').filter(file => file.endsWith('.js'));
for (const file of eventFiles) {
	const event = require(`./events/${file}`);
	if (event.once) {
		client.once(event.name, (...args) => event.execute(...args));
	} else {
		client.on(event.name, (...args) => event.execute(...args));
	}
}

client.login(process.env.TOKEN)