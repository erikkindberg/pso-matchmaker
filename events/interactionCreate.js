const interactionUtils = require("../services/interactionUtils");
const matchmakingService = require("../services/matchmakingService");
const teamService = require("../services/teamService");
const statsService = require("../services/statsService");
const authorizationService = require("../services/authorizationService");
const { MessageActionRow, MessageSelectMenu, InteractionCollector } = require("discord.js");
const { handle } = require("../utils");
const match = require("nodemon/lib/monitor/match");

module.exports = {
    name: 'interactionCreate',
    async execute(interaction) {
        if (!interaction.isCommand() && !interaction.isButton() && !interaction.isSelectMenu()) {
            return
        }

        if (!authorizationService.isBotAllowed(interaction)) {
            await interaction.reply({ content: '⛔ Please add me to this channel before using any command (I need  SEND_MESSAGES and VIEW_CHANNEL permissions)', ephemeral: true })
            return
        }

        const ban = await teamService.findBanByUserIdAndGuildId(interaction.user.id, interaction.guildId)
        if (ban) {
            await interaction.reply({ content: `⛔ You are ${ban.expireAt ? `banned until ${ban.expireAt.toUTCString()}` : 'permanently banned'}. You cannot use the bot on this server.`, ephemeral: true })
            return
        }


        if (interaction.isCommand()) {
            const command = interaction.client.commands.get(interaction.commandName);

            if (!command) return;

            if (!authorizationService.isAllowedToExecuteCommand(command, interaction.member)) {
                await interactionUtils.replyNotAllowed(interaction)
                return
            }

            try {
                await command.execute(interaction);
            } catch (error) {
                console.error(error);
                await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
                return
            }
        }

        try {
            if (interaction.isButton()) {
                if (interaction.customId.startsWith("role_")) {
                    let lineup = await teamService.retrieveLineup(interaction.channelId)
                    if (!lineup) {
                        await interactionUtils.replyLineupNotSetup(interaction)
                        return
                    }

                    const split = interaction.customId.split('_')
                    const selectedRoleName = split[1]
                    const lineupNumber = lineup.isMix() ? parseInt(split[2]) : 1
                    const selectedRole = lineup.roles.filter(role => role.lineupNumber === lineupNumber).find(role => role.name == selectedRoleName)
                    const roleLeft = lineup.roles.find(role => role.user?.id === interaction.user.id)

                    if (selectedRole.user) {
                        await interaction.reply({ content: 'A player is already signed at this position', ephemeral: true })
                        return
                    }

                    let description = `:inbox_tray: ${interaction.user} signed as **${selectedRoleName}**`
                    if (roleLeft) {
                        await teamService.removeUserFromLineup(interaction.channelId, interaction.user.id, lineupNumber)
                        await matchmakingService.removeUserFromLineupQueue(interaction.channelId, interaction.user.id)
                        description = `:outbox_tray::inbox_tray: ${interaction.user} swapped **${roleLeft.name}** with **${selectedRoleName}**`
                    }
                    
                    let userToAdd = {
                        id: interaction.user.id,
                        name: interaction.user.username
                    }
                    lineup = await teamService.addUserToLineup(interaction.channelId, selectedRoleName, userToAdd, lineupNumber)
                    await matchmakingService.addUserToLineupQueue(interaction.channelId, selectedRoleName, userToAdd, lineupNumber)

                    if (await matchmakingService.isMixOrCaptainsReadyToStart(lineup)) {
                        const embed = interactionUtils.createInformationEmbed(interaction.user, description)
                        await interaction.channel.send({ embeds: [embed] })
                        const challenge = await matchmakingService.findChallengeByChannelId(interaction.channelId)
                        const secondLineup = challenge ? await teamService.retrieveLineup(challenge.initiatingTeam.lineup.channelId === interaction.channelId ? challenge.challengedTeam.lineup.channelId : challenge.initiatingTeam.lineup.channelId) : null
                        if (await matchmakingService.checkForDuplicatedPlayers(interaction, lineup, secondLineup)) {
                            return
                        }

                        await matchmakingService.readyMatch(interaction, challenge, lineup)
                        return
                    }

                    const autoSearchResult = await matchmakingService.checkIfAutoSearch(interaction.client, interaction.user, lineup)
                    if (autoSearchResult.joinedQueue) {
                        description += `\nYour lineup is full, it is now searching for a **${lineup.size}v${lineup.size}** team !`
                    }
                    if (autoSearchResult.leftQueue) {
                        description += `\nYou are no longer searching for a team.`
                    }
                    if (autoSearchResult.cancelledChallenge) {
                        description += `\nThe challenge request has been cancelled.`
                    }

                    await interaction.update({ components: [] })
                    let reply = await interactionUtils.createReplyForLineup(interaction, lineup, autoSearchResult.updatedLineupQueue)
                    const embed = interactionUtils.createInformationEmbed(interaction.user, description)
                    reply.embeds = (reply.embeds || []).concat(embed)
                    await interaction.channel.send(reply)
                    return
                }

                if (interaction.customId.startsWith('join_')) {
                    const customId = interaction.customId.split('_')[1]

                    let lineup = await teamService.retrieveLineup(interaction.channelId)
                    if (lineup.isPicking) {
                        await interaction.reply({ content: '⛔ Captains are currently picking the teams', ephemeral: true })
                        return
                    }

                    const signedRole = lineup.roles.filter(role => role.user).find(role => role.user.id == interaction.user.id)
                    if (signedRole && ((signedRole.name.includes('GK') && customId === 'gk') || (!signedRole.name.includes('GK') && customId !== 'gk'))) {
                        await interaction.reply({ content: '⛔ You are already in the lineup', ephemeral: true })
                        return
                    }

                    const newLineup = await teamService.removeUserFromLineup(interaction.channelId, interaction.user.id)
                    if (newLineup) {
                        lineup = newLineup
                    }

                    let roleToSign
                    if (customId === 'gk') {
                        roleToSign = lineup.roles.filter(role => role.name.includes('GK')).find(role => !role.user)
                    } else {
                        roleToSign = lineup.roles.filter(role => !role.name.includes('GK')).find(role => !role.user)
                    }

                    const userToAdd = {
                        id: interaction.user.id,
                        name: interaction.user.username
                    }

                    lineup = await teamService.addUserToLineup(interaction.channelId, roleToSign.name, userToAdd, roleToSign.lineupNumber)

                    let description = `:inbox_tray: ${interaction.user} has joined the queue !`

                    if (await matchmakingService.isMixOrCaptainsReadyToStart(lineup)) {
                        lineup = await teamService.startPicking(lineup.channelId)

                        const allUserIds = lineup.roles.filter(role => role.user).map(role => role.user.id)
                        let captainsIds = (await matchmakingService.findTwoMostRelevantCaptainsIds(allUserIds)).map(result => result._id)
                        if (captainsIds.length < 2) {
                            captainsIds = [allUserIds.splice(Math.floor(Math.random() * allUserIds.length), 1)[0], allUserIds.splice(Math.floor(Math.random() * allUserIds.length), 1)[0]]
                        }
                        const firstCaptain = await interaction.client.users.fetch(captainsIds[0])
                        const secondCaptain = await interaction.client.users.fetch(captainsIds[1])
                        let currentCaptain = firstCaptain

                        description += `\nThe draft begins. The captains are ${firstCaptain} and ${secondCaptain}.\n**${firstCaptain} turn to pick**.`

                        let remainingRoles = lineup.roles.filter(role => role.user).map(role => ({ ...role.toObject() }))
                        lineup.roles.forEach(role => role.user = null)
                        let firstTeamRoles = lineup.roles.filter(role => role.lineupNumber === 1).map(role => ({ ...role.toObject() }))
                        let secondTeamRoles = lineup.roles.filter(role => role.lineupNumber === 1).map(role => ({ ...role.toObject() }))
                        secondTeamRoles.forEach(role => role.lineupNumber = 2)

                        const numberOfGksSigned = remainingRoles.filter(role => role.name.includes('GK') && role.user).length

                        const firstCaptainRole = remainingRoles.splice(remainingRoles.findIndex(role => role.user.id === firstCaptain.id), 1)[0]
                        if (firstCaptainRole.name.includes('GK')) {
                            firstTeamRoles.find(role => role.name.includes('GK')).user = firstCaptainRole.user
                        } else {
                            firstTeamRoles.find(role => !role.user).user = firstCaptainRole.user
                        }
                        const secondCaptainRole = remainingRoles.splice(remainingRoles.findIndex(role => role.user.id === secondCaptain.id), 1)[0]
                        if (secondCaptainRole.name.includes('GK')) {
                            secondTeamRoles.find(role => role.name.includes('GK')).user = secondCaptainRole.user
                        } else {
                            secondTeamRoles.find(role => !role.user).user = secondCaptainRole.user
                        }

                        if (numberOfGksSigned === 2) {
                            if (firstCaptainRole.name.includes('GK') && !secondCaptainRole.name.includes('GK')) {
                                secondTeamRoles.find(role => role.name.includes('GK')).user = remainingRoles.splice(remainingRoles.findIndex(role => role.name.includes('GK')), 1)[0].user
                            } else if (secondCaptainRole.name.includes('GK') && !firstCaptainRole.name.includes('GK')) {
                                firstTeamRoles.find(role => role.name.includes('GK')).user = remainingRoles.splice(remainingRoles.findIndex(role => role.name.includes('GK')), 1)[0].user
                            }
                        } else if (numberOfGksSigned === 1 && !firstCaptainRole.name.includes('GK') && !secondCaptainRole.name.includes('GK')) {
                            firstTeamRoles.find(role => role.name.includes('GK')).user = remainingRoles.splice(remainingRoles.findIndex(role => role.name.includes('GK')), 2)[0].user
                        }

                        lineup.roles = firstTeamRoles.concat(secondTeamRoles)

                        let reply = await interactionUtils.createReplyForLineup(interaction, lineup)
                        const embed = interactionUtils.createInformationEmbed(interaction.user, description)
                        reply.embeds = reply.embeds.concat(embed)
                        reply.components = interactionUtils.createCaptainsPickComponent(remainingRoles)
                        await interaction.update({ components: [] })
                        await interaction.channel.send(reply)

                        const filter = (interaction) => interaction.customId.startsWith('pick_');
                        const collector = interaction.channel.createMessageComponentCollector({ filter, idle: 138000 });
                        collector.on('collect', async (i) => {
                            if (i.user.id !== currentCaptain.id) {
                                await i.reply({ content: "You are not the captain or it's not your turn to pick !", ephemeral: true })
                                return
                            }
                            const pickedUserId = i.customId.split('_')[1]
                            const pickedRole = remainingRoles.splice(remainingRoles.findIndex(role => role.user.id === pickedUserId), 1)[0]
                            let teamRoles = currentCaptain.id === firstCaptain.id ? firstTeamRoles : secondTeamRoles
                            console.log("------------------")
                            console.log(teamRoles)
                            console.log("------------------")
                            if (pickedRole.name.includes('GK')) {
                                teamRoles.find(role => role.name.includes('GK')).user = pickedRole.user
                                const otherTeamRoles = currentCaptain.id === firstCaptain.id ? secondTeamRoles : firstTeamRoles
                                console.log("*****************")
                                console.log(otherTeamRoles)
                                console.log("*****************")
                                const lastGkIndex = remainingRoles.findIndex(role => role.name.includes('GK'))
                                if (lastGkIndex >= 0) {
                                    const remainingGkRole = remainingRoles.splice(lastGkIndex, 1)[0]
                                    otherTeamRoles.find(role => role.name.includes('GK')).user = remainingGkRole.user
                                }
                            } else {
                                teamRoles.find(role => !role.user).user = pickedRole.user
                            }

                            lineup.roles = firstTeamRoles.concat(secondTeamRoles)

                            if (remainingRoles.length <= 1 || teamRoles.filter(role => role.user).length === teamRoles.length || (teamRoles.filter(role => role.user).length === teamRoles.length - 1 && teamRoles.find(role => !role.user).name.includes('GK'))) {
                                teamRoles = currentCaptain.id === firstCaptain.id ? secondTeamRoles : firstTeamRoles
                                console.log("+++++++++++++++++++++++++++")
                                console.log(teamRoles)
                                console.log(remainingRoles)
                                console.log("+++++++++++++++++++++++++++++")
                                for (let remainingRole of remainingRoles) {
                                    if (remainingRole.name.includes('GK')) {
                                        teamRoles.find(role => role.name.includes('GK')).user = remainingRole.user
                                    } else {
                                        teamRoles.find(role => !role.user).user = remainingRole.user
                                    }
                                    lineup.roles = firstTeamRoles.concat(secondTeamRoles)
                                }
                                remainingRoles = []
                                await teamService.stopPicking(lineup.channelId)
                                await handle(i.update({ components: [] }))

                                const embed = interactionUtils.createInformationEmbed(interaction.user, `${i.user} has picked ${pickedRole.user.name}.\nEvery players have been picked. The match is about to start.`)
                                await interaction.followUp({ embeds: [embed] })
                                await matchmakingService.readyMatch(interaction, null, lineup)
                                collector.stop()
                                return
                            }

                            currentCaptain = currentCaptain.id === firstCaptain.id ? secondCaptain : firstCaptain

                            const embed = interactionUtils.createInformationEmbed(interaction.user, `${i.user} has picked ${pickedRole.user.name}.\n**${currentCaptain} turn to pick.**`)
                            let reply = await interactionUtils.createReplyForLineup(interaction, lineup)
                            reply.embeds = reply.embeds.concat(embed)
                            reply.components = interactionUtils.createCaptainsPickComponent(remainingRoles)
                            await i.update({ components: [] })
                            await interaction.followUp(reply)
                        })
                        collector.on('end', async (collected) => {
                            await teamService.stopPicking(lineup.channelId)
                            if (remainingRoles.length > 0) {
                                lineup = await teamService.removeUserFromLineup(interaction.channelId, currentCaptain.id)
                                let reply = await interactionUtils.createReplyForLineup(interaction, lineup)
                                reply.content = `You have been too long to pick a player. Draft has been cancelled and ${currentCaptain} has been removed from the lineup`
                                await interaction.followUp(reply)
                                return
                            }
                        })
                        return
                    }
                    const embed = interactionUtils.createInformationEmbed(interaction.user, description)
                    let reply = await interactionUtils.createReplyForLineup(interaction, lineup)
                    reply.embeds = reply.embeds.concat(embed)
                    await interaction.update({ components: [] })
                    await interaction.channel.send(reply)

                    return
                }

                if (interaction.customId === 'leaveQueue') {
                    const lineup = await teamService.removeUserFromLineup(interaction.channelId, interaction.user.id)
                    if (!lineup) {
                        await interaction.reply({ content: `⛔ You are not in the lineup`, ephemeral: true })
                        return
                    }
                    if (lineup.isPicking) {
                        await interaction.reply({ content: '⛔ Captains are currently picking the teams', ephemeral: true })
                        return
                    }
                    await interaction.update({ components: [] })
                    const embed = interactionUtils.createInformationEmbed(interaction.user, `:outbox_tray: ${interaction.user} has left the queue !`)
                    let reply = await interactionUtils.createReplyForLineup(interaction, lineup)
                    reply.embeds = reply.embeds.concat(embed)
                    interaction.channel.send(reply)
                    return
                }

                if (interaction.customId.startsWith('addMerc_')) {

                    if(!interaction.member.permissions.has(Permissions.FLAGS.ADMINISTRATOR)){
                        await interactionUtils.replyNotAllowed(interaction)
                        return  
                    }

                    const selectedLineupNumber = parseInt(interaction.customId.split('_')[1])
                    const lineup = await teamService.retrieveLineup(interaction.channelId)
                    
                    if (lineup.isMix() && !authorizationService.isMatchmakingAdmin(interaction.member)) {
                        await interaction.reply({ content: "⛔ You are not allowed to use this action", ephemeral: true })
                        return
                    }

                    const mercRoleSelectMenu = new MessageSelectMenu()
                        .setCustomId(`addMerc_select_${selectedLineupNumber}`)
                        .setPlaceholder('Select a position')

                    const availableRoles = lineup.roles.filter(role => role.lineupNumber === selectedLineupNumber).filter(role => !role.user)
                    for (let role of availableRoles) {
                        mercRoleSelectMenu.addOptions([{ label: role.name, value: role.name }])
                    }

                    await interaction.reply({ content: 'Which position do you want to sign the player on ?', components: [new MessageActionRow().addComponents(mercRoleSelectMenu)], ephemeral: true })
                    return
                }

                if (interaction.customId.startsWith('clearRole_')) {
                    
                    if(!interaction.member.permissions.has(Permissions.FLAGS.ADMINISTRATOR)){
                        await interactionUtils.replyNotAllowed(interaction)
                        return
                    }

                    const selectedLineupNumber = parseInt(interaction.customId.split('_')[1])
                    const lineup = await teamService.retrieveLineup(interaction.channelId)

                    if (lineup.isMix() && !authorizationService.isMatchmakingAdmin(interaction.member)) {
                        await interaction.reply({ content: "⛔ You are not allowed to use this action", ephemeral: true })
                        return
                    }

                    const clearRoleSelectMenu = new MessageSelectMenu()
                        .setCustomId(`clearRole_select_${selectedLineupNumber}`)
                        .setPlaceholder('Select a position')

                    const takenRoles = lineup.roles.filter(role => role.lineupNumber === selectedLineupNumber).filter(role => role.user)
                    for (let role of takenRoles) {
                        clearRoleSelectMenu.addOptions([{ label: role.name, value: role.name }])
                    }

                    await interaction.reply({ content: 'Select the position you want to clear', components: [new MessageActionRow().addComponents(clearRoleSelectMenu)], ephemeral: true })
                    return
                }

                if (interaction.customId === 'leaveLineup') {
                    let lineup = await teamService.retrieveLineup(interaction.channelId)
                    await teamService.leaveLineup(interaction, interaction.channel, lineup)
                    if (!interaction.replied) {
                        await interaction.update({ components: [] })
                    }
                    return
                }

                if (interaction.customId === 'startSearch') {
                    const challenge = await matchmakingService.findChallengeByChannelId(interaction.channelId)
                    if (challenge) {
                        await interaction.reply({ content: "⛔ You are currently challenging", ephemeral: true })
                        return
                    }
                    let lineupQueue = await matchmakingService.findLineupQueueByChannelId(interaction.channelId)
                    if (lineupQueue) {
                        await interactionUtils.replyAlreadyQueued(interaction, lineupQueue.lineup.size)
                        return
                    }
                    let lineup = await teamService.retrieveLineup(interaction.channelId)
                    if (!lineup) {
                        await interactionUtils.replyLineupNotSetup(interaction)
                        return
                    }

                    if (!matchmakingService.isLineupAllowedToJoinQueue(lineup)) {
                        interaction.reply({ content: '⛔ All outfield positions must be filled before searching', ephemeral: true })
                        return
                    }

                    lineupQueue = await matchmakingService.joinQueue(interaction.client, interaction.user, lineup)
                    await interaction.message.edit({ components: [] })
                    const embed = interactionUtils.createInformationEmbed(interaction.user, `🔎 Your team is now searching for a team to challenge`)
                    await interaction.channel.send({ embeds: [embed], components: interactionUtils.createLineupComponents(lineup, lineupQueue, challenge) })
                    return
                }

                if (interaction.customId === 'stopSearch') {
                    const challenge = await matchmakingService.findChallengeByChannelId(interaction.channelId)
                    if (challenge) {
                        await interaction.reply({ content: "⛔ You are currently challenging", ephemeral: true })
                        return
                    }
                    let lineupQueue = await matchmakingService.findLineupQueueByChannelId(interaction.channelId)
                    if (!lineupQueue) {
                        await interactionUtils.replyNotQueued(interaction)
                        return
                    }
                    await matchmakingService.leaveQueue(interaction.client, lineupQueue)
                    await interaction.message.edit({ components: [] })
                    const embed = interactionUtils.createInformationEmbed(interaction.user, `😴 Your team is no longer searching for a challenge`)
                    await interaction.channel.send({ embeds: [embed], components: interactionUtils.createLineupComponents(lineupQueue.lineup, null, challenge) })
                    return
                }

                if (interaction.customId.startsWith('challenge_')) {
                    let lineupQueueIdToChallenge = interaction.customId.substring(10);
                    await matchmakingService.challenge(interaction, lineupQueueIdToChallenge)
                    return
                }

                if (interaction.customId.startsWith('accept_challenge_')) {
                    let challengeId = interaction.customId.substring(17);
                    let challenge = await matchmakingService.findChallengeById(challengeId)
                    if (!challenge) {
                        await interaction.reply({ content: "⛔ This challenge no longer exists", ephemeral: true })
                        return
                    }
                    const lineup = await teamService.retrieveLineup(interaction.channelId)
                    if (!matchmakingService.isUserAllowedToInteractWithMatchmaking(interaction.user.id, lineup)) {
                        await interaction.reply({ content: `⛔ You must be in the lineup in order to accept a challenge`, ephemeral: true })
                        return
                    }

                    if (challenge.initiatingUser.id === interaction.user.id) {
                        await interaction.reply({ content: "⛔ You cannot accept your own challenge request", ephemeral: true })
                        return
                    }

                    const secondLineup = await teamService.retrieveLineup(challenge.initiatingTeam.lineup.channelId === interaction.channelId ? challenge.challengedTeam.lineup.channelId : challenge.initiatingTeam.lineup.channelId)
                    if (await matchmakingService.checkForDuplicatedPlayers(interaction, lineup, secondLineup)) {
                        return
                    }
                    await interaction.deferReply()
                    await matchmakingService.readyMatch(interaction, challenge)
                }

                if (interaction.customId.startsWith('refuse_challenge_')) {
                    let challengeId = interaction.customId.substring(17);
                    let challenge = await matchmakingService.findChallengeById(challengeId)
                    if (!challenge) {
                        await interaction.reply({ content: "⛔ This challenge no longer exists", ephemeral: true })
                        return
                    }

                    if (challenge.initiatingUser.id === interaction.user.id) {
                        await interaction.reply({ content: "⛔ You cannot refuse your own challenge request", ephemeral: true })
                        return
                    }

                    const lineup = await teamService.retrieveLineup(interaction.channelId)
                    if (!matchmakingService.isUserAllowedToInteractWithMatchmaking(interaction.user.id, lineup)) {
                        await interaction.reply({ content: `⛔ You must be in the lineup in order to refuse a challenge`, ephemeral: true })
                        return
                    }

                    await matchmakingService.deleteChallengeById(challengeId)
                    await matchmakingService.freeLineupQueuesByChallengeId(challengeId)

                    let initiatingTeamChannel = await interaction.client.channels.fetch(challenge.initiatingTeam.lineup.channelId)
                    await initiatingTeamChannel.messages.edit(challenge.initiatingMessageId, { components: [] })
                    await initiatingTeamChannel.send({ embeds: [interactionUtils.createInformationEmbed(interaction.user, `❌ **${teamService.formatTeamName(challenge.challengedTeam.lineup)}** has refused your challenge request`)] })

                    await interaction.message.edit({ components: [] })
                    await interaction.channel.send({ embeds: [interactionUtils.createInformationEmbed(interaction.user, `❌ ${interaction.user} has refused to challenge **${teamService.formatTeamName(challenge.initiatingTeam.lineup)}**'`)] })
                    return
                }

                if (interaction.customId.startsWith('cancel_challenge_')) {
                    const challengeId = interaction.customId.substring(17);
                    await matchmakingService.cancelChallenge(interaction.client, interaction.user, challengeId)
                    return
                }

                if (interaction.customId.startsWith('delete_team_yes_')) {
                    await matchmakingService.deleteChallengesByGuildId(interaction.guildId)
                    await matchmakingService.deleteLineupQueuesByGuildId(interaction.guildId)
                    await teamService.deleteLineupsByGuildId(interaction.guildId)
                    await teamService.deleteBansByGuildId(interaction.guildId)
                    await teamService.deleteTeam(interaction.guildId)
                    await interaction.reply({ content: '✅ Your team has been deleted', ephemeral: true })
                    return
                }

                if (interaction.customId.startsWith('delete_team_no_')) {
                    await interaction.reply({ content: 'Easy peasy ! Nothing has been deleted', ephemeral: true })
                    return
                }

                if (interaction.customId.startsWith('leaderboard_page_')) {
                    let split = interaction.customId.split('_')
                    let statsType = split[2]
                    let lineupSizes = split[3].split(',').filter(i => i)
                    let page = parseInt(split[4])
                    let guildId
                    if (statsType === 'team') {
                        guildId = interaction.guildId
                    }
                    let region
                    if (statsType.startsWith('region')) {
                        region = statsType.split(',')[1]
                    }
                    let numberOfPlayers = await statsService.countNumberOfPlayers(region, guildId, lineupSizes)
                    let numberOfPages = Math.ceil(numberOfPlayers / statsService.DEFAULT_LEADERBOARD_PAGE_SIZE)
                    let statsEmbeds = await interactionUtils.createLeaderBoardEmbeds(interaction, numberOfPages, { region, guildId, page, lineupSizes })
                    let leaderboardPaginationComponent = interactionUtils.createLeaderBoardPaginationComponent({ statsType, page, lineupSizes }, numberOfPages)
                    interaction.message.components[0] = leaderboardPaginationComponent
                    await interaction.update({ embeds: statsEmbeds, components: interaction.message.components })
                    return
                }

                if (interaction.customId.startsWith('leaderboard_first_page_')) {
                    let split = interaction.customId.split('_')
                    let statsType = split[3]
                    let lineupSizes = split[4].split(',').filter(i => i)
                    let guildId
                    if (statsType === 'team') {
                        guildId = interaction.guildId
                    }
                    let region
                    if (statsType.startsWith('region')) {
                        region = statsType.split(',')[1]
                    }
                    let numberOfPlayers = await statsService.countNumberOfPlayers(region, guildId, lineupSizes)
                    let numberOfPages = Math.ceil(numberOfPlayers / statsService.DEFAULT_LEADERBOARD_PAGE_SIZE)
                    let statsEmbeds = await interactionUtils.createLeaderBoardEmbeds(interaction, numberOfPages, { region, guildId })
                    let leaderboardPaginationComponent = interactionUtils.createLeaderBoardPaginationComponent({ statsType, page: 0, lineupSizes }, numberOfPages)
                    interaction.message.components[0] = leaderboardPaginationComponent
                    await interaction.update({ embeds: statsEmbeds, components: interaction.message.components })
                    return
                }


                if (interaction.customId.startsWith('leaderboard_last_page_')) {
                    let split = interaction.customId.split('_')
                    let statsType = split[3]
                    let lineupSizes = split[4].split(',').filter(i => i)
                    let guildId
                    if (statsType === 'team') {
                        guildId = interaction.guildId
                    }
                    let region
                    if (statsType.startsWith('region')) {
                        region = statsType.split(',')[1]
                    }
                    let numberOfPlayers = await statsService.countNumberOfPlayers(region, guildId, lineupSizes)
                    let numberOfPages = Math.ceil(numberOfPlayers / statsService.DEFAULT_LEADERBOARD_PAGE_SIZE)
                    let statsEmbeds = await interactionUtils.createLeaderBoardEmbeds(interaction, numberOfPages, { region, guildId, page: numberOfPages - 1 })
                    let leaderboardPaginationComponent = interactionUtils.createLeaderBoardPaginationComponent({ statsType, page: numberOfPages - 1, lineupSizes }, numberOfPages)
                    interaction.message.components[0] = leaderboardPaginationComponent
                    await interaction.update({ embeds: statsEmbeds, components: interaction.message.components })
                    return
                }

                if (interaction.customId.startsWith('mix_lineup_')) {
                    const split = interaction.customId.split('_')
                    const selectedLineup = parseInt(split[2])
                    let lineup = await teamService.retrieveLineup(interaction.channelId)
                    console.log(lineup)
                    const components = interactionUtils.createLineupComponents(interaction, lineup, null, null, selectedLineup)
                    await interaction.reply({ content: `What do you want to do in the **${selectedLineup === 1 ? 'Red' : 'Blue'} Team** ?`, components, ephemeral: true })
                }
            }

            if (interaction.isSelectMenu()) {
                if (interaction.customId.startsWith('stats_type_select_')) {
                    let split = interaction.customId.split('_')
                    let userId = split[3]
                    const statsType = interaction.values[0]
                    let guildId
                    if (statsType === 'team') {
                        guildId = interaction.guildId
                    }
                    let region
                    if (statsType.startsWith('region')) {
                        region = statsType.split(',')[1]
                    }
                    let statsEmbeds = await interactionUtils.createStatsEmbeds(interaction, userId, region, guildId)
                    await interaction.update({ embeds: statsEmbeds })
                    return
                }

                if (interaction.customId.startsWith('leaderboard_type_select')) {
                    let statsType = interaction.values[0]
                    let guildId
                    if (statsType === 'team') {
                        guildId = interaction.guildId
                    }
                    let region
                    if (statsType.startsWith('region')) {
                        region = statsType.split(',')[1]
                    }
                    let numberOfPlayers = await statsService.countNumberOfPlayers(region, guildId)
                    let numberOfPages = Math.ceil(numberOfPlayers / statsService.DEFAULT_LEADERBOARD_PAGE_SIZE)
                    let statsEmbeds = await interactionUtils.createLeaderBoardEmbeds(interaction, numberOfPages, { region, guildId })
                    let leaderboardPaginationComponent = interactionUtils.createLeaderBoardPaginationComponent({ statsType, page: 0, lineupSizes: [] }, numberOfPages)
                    interaction.message.components[0] = leaderboardPaginationComponent
                    interaction.message.components[2] = interactionUtils.createLeaderBoardLineupSizeComponent(statsType)
                    await interaction.update({ embeds: statsEmbeds, components: interaction.message.components })
                    return
                }

                if (interaction.customId.startsWith('leaderboard_lineup_size_select_')) {
                    let split = interaction.customId.split('_')
                    let statsType = split[4]
                    let selectedSizes = interaction.values
                    let guildId
                    if (statsType === 'team') {
                        guildId = interaction.guildId
                    }
                    let region
                    if (statsType.startsWith('region')) {
                        region = statsType.split(',')[1]
                    }
                    let numberOfPlayers = await statsService.countNumberOfPlayers(region, guildId, selectedSizes)
                    let numberOfPages = Math.ceil(numberOfPlayers / statsService.DEFAULT_LEADERBOARD_PAGE_SIZE)
                    let statsEmbeds = await interactionUtils.createLeaderBoardEmbeds(interaction, numberOfPages, { region, guildId, lineupSizes: selectedSizes })
                    let leaderboardPaginationComponent = interactionUtils.createLeaderBoardPaginationComponent({ statsType, page: 0, lineupSizes: selectedSizes }, numberOfPages)
                    interaction.message.components[0] = leaderboardPaginationComponent
                    await interaction.update({ embeds: statsEmbeds, components: interaction.message.components })
                    return
                }

                if (interaction.customId.startsWith('addMerc_select_')) {
                    const selectedLineupNumber = parseInt(interaction.customId.split('_')[2])
                    const selectedMercRole = interaction.values[0]

                    let lineup = await teamService.retrieveLineup(interaction.channelId)
                    const roles = lineup.roles.filter(role => role.lineupNumber === selectedLineupNumber)
                    if (roles.find(role => role.name === selectedMercRole).user?.id) {
                        await interaction.reply({ content: `Too late ! Someone has already signed as **${selectedMercRole}**. Please try again.`, ephemeral: true })
                        return
                    }

                    const filter = m => interaction.user.id === m.author.id
                    const collector = interaction.channel.createMessageCollector({ filter, time: 10000, max: 1 });
                    collector.on('collect', async m => {
                        let lineup = await teamService.retrieveLineup(interaction.channelId)
                        if (roles.find(role => role.name === selectedMercRole).user?.id) {
                            await interaction.followUp({ content: `Too late ! Someone has already signed as **${selectedMercRole}**. Please try again.`, ephemeral: true })
                            return
                        }

                        let userToAdd
                        let addedPlayerName
                        if (m.mentions.users.size > 0) {
                            const [user] = await handle(interaction.client.users.fetch(m.mentions.users.at(0).id))
                            if (user) {
                                const ban = await teamService.findBanByUserIdAndGuildId(user.id, interaction.guildId)
                                if (ban) {
                                    await interaction.followUp({ content: `⛔ Player ${m.content} is banned and cannot be signed.`, ephemeral: true })
                                    return
                                }
                                if (user.bot) {
                                    await interaction.followUp({ content: 'Nice try 😉', ephemeral: true })
                                    return
                                }
                                if (lineup.roles.some(role => role.user?.id === user.id)) {
                                    await interaction.followUp({ content: `Player ${m.content} is already signed !`, ephemeral: true })
                                    return
                                }
                                addedPlayerName = user.toString()
                                userToAdd = {
                                    id: user.id,
                                    name: user.username
                                }
                            }
                        } else {
                            addedPlayerName = m.content
                            userToAdd = {
                                id: "merc",
                                name: m.content
                            }
                        }

                        lineup = await teamService.addUserToLineup(interaction.channelId, selectedMercRole, userToAdd, selectedLineupNumber)
                        await matchmakingService.addUserToLineupQueue(interaction.channelId, selectedMercRole, userToAdd, selectedLineupNumber)

                        let description = `:inbox_tray: ${interaction.user} manually signed **${addedPlayerName}** as **${selectedMercRole}**`
                        const autoSearchResult = await matchmakingService.checkIfAutoSearch(interaction.client, interaction.user, lineup)
                        if (autoSearchResult.joinedQueue) {
                            description += `\nYour lineup is full, it is now searching for a **${lineup.size}v${lineup.size}** team !`
                        }
                        if (autoSearchResult.leftQueue) {
                            description += `\nYou are no longer searching for a team.`
                        }
                        if (autoSearchResult.cancelledChallenge) {
                            description += `\nThe challenge request has been cancelled.`
                        }
                        const embed = interactionUtils.createInformationEmbed(interaction.user, description)
                        if (await matchmakingService.isMixOrCaptainsReadyToStart(lineup)) {
                            await interaction.channel.send({ embeds: [embed] })
                            const challenge = await matchmakingService.findChallengeByChannelId(interaction.channelId)
                            const secondLineup = challenge ? await teamService.retrieveLineup(challenge.initiatingTeam.lineup.channelId === interaction.channelId ? challenge.challengedTeam.lineup.channelId : challenge.initiatingTeam.lineup.channelId) : null
                            if (await matchmakingService.checkForDuplicatedPlayers(interaction, lineup, secondLineup)) {
                                return
                            }
                            await matchmakingService.readyMatch(interaction, challenge, lineup)
                            return
                        }

                        let reply = await interactionUtils.createReplyForLineup(interaction, lineup, autoSearchResult.updatedLineupQueue)
                        reply.embeds = (reply.embeds || []).concat(embed)
                        await interaction.channel.send(reply)
                    })

                    collector.on('end', async collected => {
                        if (collected.size === 0) {
                            await interaction.followUp({ content: "Sorry, you have taken too long to answer me ...", components: [], ephemeral: true })
                            return
                        }
                    })

                    await interaction.reply({ content: `Type the name of the player you want to sign to the **${selectedMercRole}** position`, components: [], ephemeral: true })
                    return
                }

                if (interaction.customId.startsWith('clearRole_select_')) {
                    const selectedLineupNumber = parseInt(interaction.customId.split('_')[2])
                    const selectedRoleToClear = interaction.values[0]

                    let lineup = await teamService.retrieveLineup(interaction.channelId)
                    const roles = lineup.roles.filter(role => role.lineupNumber === selectedLineupNumber)
                    if (!roles.find(role => role.name === selectedRoleToClear).user) {
                        await interaction.reply({ content: `The ${selectedRoleToClear} is already empty !`, ephemeral: true })
                        return
                    }

                    lineup = await teamService.clearRoleFromLineup(interaction.channelId, selectedRoleToClear, selectedLineupNumber)

                    let description = `:outbox_tray: ${interaction.user} cleared the **${selectedRoleToClear}** position`
                    const autoSearchResult = await matchmakingService.checkIfAutoSearch(interaction.client, interaction.user, lineup)
                    if (autoSearchResult.leftQueue) {
                        description += `\nYou are no longer searching for a team.`
                    }
                    if (autoSearchResult.cancelledChallenge) {
                        description += `\nThe challenge request has been cancelled.`
                    }
                    let reply = await interactionUtils.createReplyForLineup(interaction, lineup, autoSearchResult.updatedLineupQueue)
                    const embed = interactionUtils.createInformationEmbed(interaction.user, description)
                    reply.embeds = (reply.embeds || []).concat(embed)
                    await interaction.channel.send(reply)
                    await interaction.update({ components: [], ephemeral: true })
                    return
                }

                if (interaction.customId === 'challenge_select') {
                    await matchmakingService.challenge(interaction, interaction.values[0])
                    return
                }
            }
        }
        catch (error) {
            console.error(error);
            try {
                await interaction.reply({ content: 'There was an error while executing this interaction!', ephemeral: true });
            } catch (error) {
                //Shush
            }
        }
    }
}