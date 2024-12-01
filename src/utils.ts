import { WebSocket } from "ws";

const YT_Regex = /^(?:(?:https?:)?\/\/)?(?:www\.)?(?:m\.)?(?:youtu(?:be)?\.com\/(?:v\/|embed\/|watch(?:\/|\?v=))|youtu\.be\/)((?:\w|-){11})(?:\S+)?$/;

export const isValidYoutubeURL = (data : string) =>{
    return data.match(YT_Regex);
}

export const getVideoId = (url : string) =>{
    return url.match(YT_Regex)?.[1];
}