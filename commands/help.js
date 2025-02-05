const { SlashCommandBuilder } = require('@discordjs/builders');
const { MessageEmbed } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Something you don\'t understand ?'),
    async execute(interaction) {
        const titleEmbed = new MessageEmbed()
            .setColor('#0099ff')
            .setTitle(`What is GrassPugs ?`)
            .setTimestamp()
            .setDescription(`**GrassPugs** is a discord bot that is here to help you create your own **team** with your friends and challenge other **teams**. 
            Each **Team** can be a *competitive* team (with members that compete in the EUSL for example), or a *mix* team (with any EUSL player mixed all together)`)

        const setupEmbed = new MessageEmbed()
            .setColor('#566573')
            .setTitle(`How to configure the bot ?`)
            .setTimestamp()
            .addField('1) Invite the bot on your discord', `Click on the following link to invite the bot on your discord server: https://discord.com/api/oauth2/authorize?client_id=952298356535873636&permissions=2147904576&scope=bot%20applications.commands`)
            .addField('2) Create your team', `Use the **/register_team** command anywhere on your discord server to create your team.`)
            .addField('3) Create lineups', `
         On any channel in you discord server, use one of the following command to configure a lineup and get ready to play and face other teams.

         **/setup_lineup**: If you want to challenge other teams and mix, this is the command you need. You just have to choose a size and you're ready to go !

         **/setup_mix**: If you want to play with friends, but don't want to make it official or play in any competition, you can use this command to setup a mix lineup. With mix, you can play with each other, or even against a team if they decide to challenge you!

         **/setup_mix_captains**: This command is very similar to the /setup_mix command, but instead of choosing a pre-defined position, the teams are picked by a captain on each team`)
            .addField('4) Command Permissions', `
            The following commands require higher permissions to be used: 
            - **/register_team**
            - **/team_name**
            - **/team_region**
            - **/delete_team**
            - **/setup_lineup**
            - **/setup_mix**
            - **/setup_mix_captains**
            - **/delete_lineup**
            - **/ban**
            - **/unban**
            - **/ban_list**

            Admins and moderators have access to these commands.
         `)

        const matchmakingEmbed = new MessageEmbed()
            .setColor('#566573')
            .setTitle(`How to use the matchmaking ?`)
            .setTimestamp()
            .addField('Want to see the teams that are looking for a match ?', `Use the **/challenges** command.`)
            .addField('Want other teams to be aware that you are looking for a match ?', `Use the **/search** command.`)
            .addField('Want to hide your team from other teams ?', `Use the **/stop_search** command.`)
            .addField('Want to sign in your lineup or see its status ?', `Use the **/status** command.`)

        const otherEmbed = new MessageEmbed()
            .setColor('#566573')
            .setTitle(`Other`)
            .setTimestamp()
            .addField('Want to report a bug or suggest a feature ?', 'Send a direct message to Erikk#4458')

        await interaction.reply({
            embeds: [titleEmbed, setupEmbed, matchmakingEmbed, otherEmbed],
            ephemeral: true
        })
    },
};