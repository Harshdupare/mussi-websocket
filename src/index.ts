//@ts-ignore
import WebSocket ,{ WebSocketServer } from "ws";
import { StreamManager } from "./StreamManager";

import  http  from "http";
import jwt from "jsonwebtoken";

type Data = {
    userId : string;
    spaceId : string;
    token : string;
    url : string;
    vote : "upvote" | "downvote";
    streamId : string;
}

function createHttpServer(){
    return http.createServer((req : any, res : any)=>{
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain");
        res.end("server is running");
    })
}

async function  main() {
    const server = createHttpServer();
    const wss = new WebSocketServer({server});
    await StreamManager.getInstance().initRedisClient();

    wss.on("connection", (ws : WebSocket)=> handleConnection(ws));
    const PORT = 8080;

    server.listen(PORT, ()=>{{
        console.log(`listening on port : ${PORT}`);
    }})

}
main();

function handleConnection(ws : WebSocket){
    ws.on('message', async(raw : WebSocket.RawData) =>{
        const {type ,data} = JSON.parse(raw.toString()) || {};

        switch(type){
            case "join-room":
                await handleJoinRoom(ws , data);
                break;
            default :
                await handleUserAction(ws , type, data);
        }
    });

    ws.on('close', ()=>{
        StreamManager.getInstance().disconnect(ws);
    });
}

async function handleJoinRoom(ws : WebSocket , data : Data){
    jwt.verify(
        data.token,
        "sceret",
        (err : any , decoded : any)=>{
            if(err){
                console.log(err);
                ws.send(JSON.stringify({error : err , data : "Token verification failde"}));
            }else{
                StreamManager.getInstance().joinRoom(
                    data.spaceId,
                    decoded.creatorId,
                    decoded.userId,
                    ws,
                    data.token
                );
            }
        }

    )
}

async function handleUserAction(ws : WebSocket , type: string , data : Data){
    const user = StreamManager.getInstance().users.get(data.userId);

    if(user){
        data.userId = user.userId;
        await processUserAction(type, data);
    }else {
        ws.send(JSON.stringify({message : "Unauthoized to perform  this action"}));
    }
}

async function processUserAction(type : string , data : Data){
    switch(type){
        case "cast-vote":
            await StreamManager.getInstance().castVote(
                data.userId,
                data.streamId,
                data.vote,
                data.spaceId
            );
            break;
        case "add-to-queue":
            await StreamManager.getInstance().addToQueue(
                data.spaceId,
                data.userId,
                data.url
            );
            break;
        case "play-next":
            await StreamManager.getInstance().queue.add('play-next',{
                spaceId: data.spaceId,
                userId : data.userId,
            });
            break;
        case "remove-song":
            await StreamManager.getInstance().queue.add("remove-song",{
                ...data,
                spaceId : data.spaceId,
                userId : data.userId,
            })
            break;
        case "empty-queue":
            await StreamManager.getInstance().queue.add("empty-queue",{
                ...data,
                spaceId : data.spaceId,
                userId : data.userId,
            })
            break;
        case "pay-and-play-next":
            await StreamManager.getInstance().payAndPlayNext(
                data.spaceId,
                data.userId,
                data.url
            );
            break;

        default:
            console.warn("Unknown message type : ", type);
    }
}


