import { extension_prompt_types, extension_prompt_roles, chat, chat_metadata, event_types, eventSource, saveSettingsDebounced, updateMessageBlock } from '../../../../script.js';
import { getContext, saveMetadataDebounced, extension_settings } from '../../../extensions.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { SlashCommandEnumValue, enumTypes } from '../../../slash-commands/SlashCommandEnumValue.js'
import { commonEnumProviders } from '../../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { isTrueBoolean, getCharaFilename, deepMerge } from '../../../utils.js';
import { yaml } from '../../../../lib.js';
import { metadata_keys as authors_note_keys } from '../../../authors-note.js';
import { system_messages, system_message_types } from '../../../system-messages.js'
import { getMessageTimeStamp } from '../../../RossAscends-mods.js';



export { MODULE_NAME };

const MODULE_NAME = 'namedCharacter';

/**
 * @typedef {object} YAMLBlockResult - object representing the result of a YAML block extraction
 * @property {Array} matches - an array of matches found in the text
 * @property {string} leftoverText - the leftover text after removing the YAML block 
 */

export const metadata_keys = {
    characters: 'characters',
    locations: 'locations'
};

const savedData = {
    updated: false,
    categories: [
        {
            name: metadata_keys.characters,
            data: new Map(),
            header: "# Named Character",
            replace: 'named character',
            tags: [ "namedcharacter", "clothing", "opinion"]
        },
        {
            name: metadata_keys.locations,
            data: new Map(),
            header: "# Location",
            replace: "location",
            tags: [ "location", "currentlocation"]
        }
    ]

};

// not sure if this is needed, but keeping it for now
const YAMLDataSchema = {
    type: "object",
    properties: {
        id: { type: "string" },
        name: { type: "string" }
    },
    required: ["id", "name"],
    additionalProperties: true // Allow additional properties
};

/**
 * Converts the data array for each category into a block of YAML
 * @returns {string} the important data for each category in YAML
 */

function createYAML() {
    let yamlText = '';

    if(!savedData || !savedData.categories){
        return yamlText;
    }

    savedData.categories.forEach((cat) =>{
        //add the data elements as individual yaml documents
        cat.data.values().forEach((val) => {
            yamlText += '\n---\n\n'; //signals a new document
            yamlText += cat.header + "\n";
            yamlText += yaml.stringify(val, { "doubleQuotedAsJSON": true, "doubleQuotedMinMultiLineLength": 1024, "lineWidth": 1024});
        });
    });
    return yamlText;
}

async function setDataExtensionPrompt() {
    const context = getContext();

    savedData.categories.forEach((cat) =>{
        if(!cat.data || cat.data.size == 0) {
            cat.data = new Map();

            //we want to try and load the saved data
            const metadata = context.chatMetadata[cat.name];
            if(metadata && Array.isArray(metadata)) {
                metadata.forEach((item) => {
                    if(item && item.id) {
                        cat.data.set(item.id, item);
                    }
                });
            }

            //flag as updated so we make sure to re-generate the YAML and set the prompt
            savedData.updated = true;
        }
    });

    if(savedData.updated === true) {
        savedData.updated = false;
        const yaml = createYAML();
        context.setExtensionPrompt(`${MODULE_NAME}_data_yaml`, yaml, extension_prompt_types.BEFORE_PROMPT , 1, false, extension_prompt_roles.SYSTEM);
        
        
        savedData.categories.forEach((cat) => {
             context.chatMetadata[cat.name] = cat.data.values().toArray();
        });
        saveMetadataDebounced();
        

    }
}

async function setRulesExtensionPrompt() {
    const context = getContext();

    if(context.extensionSettings && context.extensionSettings.note && context.extensionSettings.note.chara) {
        let charaNote = context.extensionSettings.note.chara.find((chara) => chara.name === getCharaFilename());
        
        //load the default if the prompt is null or whitespace
        if(!charaNote || !charaNote.prompt || /^\s*$/.test(charaNote.prompt)) {
            //we need to create a new charaNote for the default rules

            if(!charaNote) { //create a new charaNote
                    charaNote = {
                    name: getCharaFilename(),
                }
                context.extensionSettings.note.chara.push(charaNote);
            }

            //update the charaNote with the default rules
            const defaultRulesResponse = await fetch('./scripts/extensions/third-party/SillyRPG_Prototype/defaultrules.json');
            const defaultrules = await defaultRulesResponse.json();
            
            charaNote.prompt = yaml.stringify(defaultrules);
            charaNote.useChara = false; //we don't actually want to use the charaNote, we are just using it for storage and editing until we build a real UI.
            context.saveSettingsDebounced();
        }
        context.setExtensionPrompt(`${MODULE_NAME}_rules_yaml`, charaNote.prompt, extension_prompt_types.BEFORE_PROMPT , 0, false, extension_prompt_roles.SYSTEM);
    }
}

/*
 * event for when we recieve a message from the AI
 */
function onMessageReceived(event) {
    const context = getContext();

    // Check if the event is a chat message
    if(!context.chat || !context.chat[event] || !context.chat[event].mes) {
        return;
    }

    let messageText = context.chat[event].mes;
    let updatedMessage = false;

    for(const cat of savedData.categories) {
        for(const tag of cat.tags) {
            const regex = new RegExp(`<${tag}\\s*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
            const matches = [...messageText.matchAll(regex)];

            let replaceText = '';
            for(const match of matches) {
                const parsedYAML = yaml.parse(match[1], (key, value) => {
                    if(key === "id" && typeof value !== "string") {
                        return value.toString().padStart(4, '0');; // ensure id is a string
                    }
                    return value; // return other values as they are
                });
                
                //if parsedYAML or parsedYAML.id is undefined then skip this item.
                if(!parsedYAML || !parsedYAML.id) {
                    continue;
                }

                if(cat.data.has(parsedYAML.id)) {
                    const existingObject = cat.data.get(parsedYAML.id);
                    Object.assign(existingObject, parsedYAML);

                    cat.data.set(parsedYAML.id, existingObject);
                    replaceText = `Updated ${cat.replace} - ${existingObject.name}</br>`
                }
                else {
                    cat.data.set(parsedYAML.id, parsedYAML);
                    replaceText = `Added ${cat.replace} - ${parsedYAML.name}</br>`
                }
            }

            if(matches && matches.length > 0) {
                messageText = messageText.replace(regex, replaceText).trim();
                updatedMessage = true;
            }
        }
    }

    if(updatedMessage) {
        savedData.updated = true;
        context.chat[event].mes = messageText; // Update the message with the text after removing the YAML block
        updateMessageBlock(event, context.chat[event]); // Update the message in the chat
    }
}

/**
 * event for when the Context Generation has started
 */
async function onGenerationStarted() {
    setDataExtensionPrompt();
    setRulesExtensionPrompt();
}

/**  
 * event for when a new chat is loaded
 * we need to blank out the saved character data
 */
async function onChatChanged() {
    
    //reset the save data
    //savedData.updated = true;
    savedData.categories.forEach( (cat) => {
        cat.data.clear();
    });

    setDataExtensionPrompt();
    setRulesExtensionPrompt();
}


// primary main() function for jQuery
jQuery(function () {

    console.log('SaveNamedCharacter extension loaded');
    const context = getContext();
    
    //register events
    console.log('SaveNamedCharacter: Registering event listeners');
    context.eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    context.eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    context.eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted)
 
   
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'npc',
        callback: (args, value) => {
            if(args.list) {
                const context = getContext();
                if(args.list === "clear") {
                    savedData.categories.forEach((cat) => {
                        cat.data = new Map();
                        context.chatMetadata[cat.name] = [];
                    });

                    context.setExtensionPrompt(`${MODULE_NAME}_data_yaml`, '', extension_prompt_types.BEFORE_PROMPT , 1, false, extension_prompt_roles.SYSTEM);
                    saveMetadataDebounced();
                    
                    return '';
                } else {
                    const yaml = createYAML();
                    context.sendSystemMessage(system_message_types.GENERIC, '<pre style="text-wrap: wrap">\n' + yaml + '</pre>');
                    return yaml;
                }
            } else if (args.delete) {
                savedData.categories.forEach( (cat) => {
                    if(cat.data) {
                        cat.data.delete(args.delete);
                        savedData.updated = true;

                        const msg = `namedCharacter: Deleted object with id ${args.delete} from ${cat.name}`;
                        context.sendSystemMessage(system_message_types.GENERIC, msg);
                        setDataExtensionPrompt();
                        return msg;
                    }
                });
            } else if (args.update && args.property && args.value) {
                savedData.categories.forEach( (cat) => {
                    if(cat.data) {
                        const dataObject = cat.data.get(args.update);
                        dataObject[args.property.toString()] = args.value.toString();
                        savedData.updated = true;

                        const msg = `namedCharacter: Updated object with id ${args.update} property ${args.property} to value ${args.value} in ${cat.name}`;
                        context.sendSystemMessage(system_message_types.GENERIC, msg);
                        setDataExtensionPrompt();
                        return msg;
                    }
                });
            }
            return '';
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'list',
                defaultValue: 'all',
                description: 'Type of NPC list to display',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                enumList: [
                    new SlashCommandEnumValue('all', 'List all NPCs'),
                    new SlashCommandEnumValue('location', 'List NPCs by location'),
                    new SlashCommandEnumValue('character', 'List named character NPCs'),
                    new SlashCommandEnumValue('clear', 'deletes all the saved data'),
                ],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'update',
                description: '4-digit hexadecimal identifier of the item to update',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'delete',
                description: '4-digit hexadecimal identifier of the item to delete',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'property',
                description: 'name of the property to update',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'value',
                description: 'the value to update the property too',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        helpString: 'NPC management commands. Use list=all, list=location, or list=character.',  
    }));
    
        


});

