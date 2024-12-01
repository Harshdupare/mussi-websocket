//@ts-ignore
import {z} from 'zod';
//@ts-ignore
import youtubesearchapi from "youtube-search-api";
import WebSocket, { Data } from 'ws';
import { createClient , RedisClientType } from 'redis';
import { Job, Queue, Worker} from 'bullmq';
import { PrismaClient } from '@prisma/client';
import {getVideoId , isValidYoutubeURL} from './utils';
 

const TIME_SPAN_FOR_VOTE = 1200000;
const TIME_SPAN_FOR_QUEUE = 1200000;
const TIME_SPAN_FOR_REPEAT = 3600000;
const MAX_QUEUE_LENGTH = 20;

const connection = {
    username: process.env.R_USERNAME || "",
    password : process.env.R_PASSWORD || "",
    host : process.env.R_HOST || "",
    port : parseInt(process.env.R_PORT || "") || 6379,
}

const redisCredentials ={
    url : `redis://${connection.username}:${connection.password}@${connection.host}:${connection.port}`,
}

type User = {
    userId : string;
    ws : WebSocket[];
    token : string;
}

type Space = {
    creatorId: string;
    users: Map<String, User>;
}


export class StreamManager{
    private static instance : StreamManager;
    public spaces : Map<string, Space>;
    public users : Map<string, User>;
    public redisClient : RedisClientType;
    public publisher : RedisClientType;
    public subscriber : RedisClientType;
    public prisma : PrismaClient;
    public worker : Worker;
    public queue : Queue;
    public wstoSpace : Map<WebSocket ,string>;


    constructor(){
        this.spaces = new Map();
        this.users = new Map();
        this.redisClient = createClient(redisCredentials);
        this.publisher = createClient(redisCredentials);
        this.subscriber = createClient(redisCredentials);
        this.prisma = new PrismaClient();
        this.queue = new Queue(process.pid.toString() , {
            connection,
        })
        this.worker = new Worker(process.pid.toString(), this.processJob,{
            connection,
        })
        this.wstoSpace = new Map();
    }

    public static getInstance(){
        if(!this.instance){
            this.instance = new StreamManager();
        }

        return this.instance;
    }

    async initRedisClient(){
        await this.redisClient.connect();
        await this.subscriber.connect();
        await this.publisher.connect();
    }

    disconnect(ws : WebSocket){
        console.log(process.pid + " : disconnect");
        let userId : string | null = null;
        const spaceId = this.wstoSpace.get(ws);
        this.users.forEach((user , id) =>{
            const wsIndex = user.ws.indexOf(ws);

            if(wsIndex !== -1){
                userId = id;
                user.ws.splice(wsIndex, 1);
            }

            if(user.ws.length === 0){
                this.users.delete(id);
            }

        });

        if(userId && spaceId){
            const space = this.spaces.get(spaceId);
            if(space){
                const updatedUsers = new Map(
                    Array.from(space.users).filter(([usrId]) => usrId !== userId)
                );
                
                this.spaces.set(spaceId, {
                    ...space,
                    users: updatedUsers,     
                });
            }

        }
    }

    async joinRoom(
        spaceId : string,
        creatorId : string,
        userId : string,
        ws : WebSocket,
        token : string
    ){
        console.log("join Room " + spaceId);

        let space = this.spaces.get(spaceId);
        let user = this.users.get(userId);

        if(!space){
            await this.createRoom(spaceId);
            space = this.spaces.get(spaceId);
        }

        if(!user){
            await this.addUser(userId , ws , token);
            user = this.users.get(userId);
        }else{
            if(!user.ws.some((existingWs) => existingWs === ws)){
                user.ws.push(ws);
            }
        }

        this.wstoSpace.set(ws , spaceId);

        if(space && user){
            space.users.set(userId , user);
            this.spaces.set(spaceId, {
                ...space,
                creatorId : creatorId,
                users : new Map(space.users),
            });
        }

    }

    async createRoom(spaceId : string){
        console.log(process.pid + " : creatRoom: ", {spaceId});
        if(!this.spaces.has(spaceId)){
            this.spaces.set(spaceId , {
                users : new Map<string , User>(),
                creatorId : "",
            });

            await this.subscriber.subscribe(spaceId, this.onSubscribeRoom);

        }
    }

    async addUser(userId : string, ws : WebSocket, token : string){
        let user = this.users.get(userId);
        if(!user){
            this.users.set(userId , {
                userId,
                ws : [ws],
                token,
            });
        }else{
            if(!user.ws.some((existingWs) => existingWs === ws)){
                user.ws.push(ws);
            }
        }
    }

    onSubscribeRoom(message : string , spaceId:string){
        console.log("Subscribe Room ", spaceId);
        const { type , data } = JSON.parse(message);
        if(type === "new-stream"){
            StreamManager.getInstance().publishNewStream(spaceId, data);
        }else if(type === "new-vote"){
            StreamManager.getInstance().publishNewVote(
                spaceId,
                data.streamId,
                data.vote,
                data.votedBy
            );
        }else if(type === "play-next"){
            StreamManager.getInstance().publishPlayNext(spaceId);
        }else if(type === "remove-song"){   
            StreamManager.getInstance().publishRemoveSong(spaceId, data.streamId);
        }else if(type === "empty-queue"){
            StreamManager.getInstance().publishEmptyQueue(spaceId);
        }
    }


    publishNewStream(spaceId:string , data : Data){
        const space = this.spaces.get(spaceId);
        
        if(space){
            space?.users.forEach((user, userId) =>{
                user?.ws.forEach((ws) =>{
                    ws.send(
                        JSON.stringify({
                            type: `new-stream/${spaceId}`,
                            data : data,
                        })
                    );
                });
            });
        }

    }

    publishNewVote(spaceId :string , streamId : string , vote : "upvote"| "downvote" , votedBy : string ){
        console.log(process.pid + " publishNewVote");
        const spaces = this.spaces.get(spaceId);
        
        spaces?.users.forEach((user, userId) =>{
            user?.ws.forEach((ws) =>{
                ws.send(
                    JSON.stringify({
                        type : `new-vote/${spaceId}`,
                        data : {
                            vote,
                            streamId,
                            spaceId,
                            votedBy
                        }
                    })
                );
            });
        });

    }

    publishPlayNext(spaceId : string){
        const space = this.spaces.get(spaceId);
        space?.users.forEach((user , userId) =>{
            user?.ws.forEach((ws)=>{
                ws.send(
                    JSON.stringify({ 
                        type : `play-next/${spaceId}`,
                    })
                )
            });
        });
    }

    publishRemoveSong(spaceId : string , streamId : string){
        const space = this.spaces.get(spaceId);

        space?.users.forEach((user , userId) =>{
            user?.ws.forEach((ws) =>{
                ws.send(
                    JSON.stringify({
                        type :  `remove-song/${spaceId}`,
                        data : {
                            spaceId : spaceId,
                            streamId : streamId,
                        }
                    })
                )
            })
        })
    }

    publishEmptyQueue(spaceId : string){
        const space = this.spaces.get(spaceId);

        space?.users.forEach((user, userId) =>{
            user?.ws.forEach((ws) =>{
                ws.send(
                    JSON.stringify({
                        type : `empty-queue/${spaceId}`,
                    })
                )
            })
        })
    }

    async castVote(streamId : string , userId : string , vote : "upvote" | "downvote" , spaceId : string){
        console.log(process.pid + " castVote");
        const space = this.spaces.get(spaceId);
        const currentUser = this.users.get(userId);
        const creatorId = this.spaces.get(spaceId)?.creatorId;
        const isCreator = currentUser?.userId === creatorId;

        if(!space || !currentUser){
            return;
        }

        if(!isCreator){
            const lastVoted = await this.redisClient.get(
                `lastVoted-${spaceId}-${userId}`
            );

            if(lastVoted){
                currentUser?.ws.forEach((ws) =>{
                    ws.send(
                        JSON.stringify({
                            type:"error",
                            data : {
                                message : "You can vote after 20 mins",
                            }
                        })
                    )
                });
                return ;
            }
            await this.queue.add("cast-vote", {
                creatorId,
                userId,
                streamId,
                vote,
                spaceId: spaceId,
            });
        }
    }
    
    async addToQueue(spaceId : string, currentUserId: string, url: string){
        console.log(process.pid + ": addToQueue");
        const space = this.spaces.get(spaceId);
        const currentUser = this.users.get(currentUserId);
        const creatorId = this.spaces.get(spaceId)?.creatorId;
        const isCreator = currentUser?.userId === creatorId;

        if(!space || !currentUser){
            console.log("433 : Room or user not defined")
            return;
        }

        if(!isValidYoutubeURL(url)){
            currentUser?.ws.forEach((ws)=>{
                ws.send(
                    JSON.stringify({
                        type : "error",
                        data : {
                            message : "Invalid Youtube URL",
                        }
                    })
                )
            });
            return;
        }

        let previousQueueLength = parseInt(
            (await this.redisClient.get(`queue-length-${spaceId}`)) || "0", 10
        )

        if(!previousQueueLength){
            previousQueueLength = await this.prisma.stream.count({
                where : {
                    spaceId: spaceId,
                    played: false,
                }
            });
        }

        if(!isCreator){
            let lastAdded = await this.redisClient.get(
                `lastAdded-${spaceId}-${currentUserId}`
            );

            if(lastAdded){
                currentUser.ws.forEach((ws) =>{
                    ws.send(
                        JSON.stringify({
                            type: "error",
                            data : {
                                message : "You can add again after 20 min.",
                            }
                        })
                    )
                });
                return;
            }

            let alreadyAdded = await this.redisClient.get(`${spaceId}-${url}`);

            if(alreadyAdded){
                currentUser.ws.forEach((ws)=>{
                    ws.send(
                        JSON.stringify({
                            type:"error",
                            data : {
                                message : "This song is blocked for 1 hour",
                            }
                        })
                    )
                });
                return;
            }

            if(previousQueueLength >= MAX_QUEUE_LENGTH){
                currentUser.ws.forEach((ws)=>{
                    ws.send(
                        JSON.stringify({
                            type : 'error',
                            data : {
                                message : "Queue limit reached",
                            }
                        })
                    )
                });
                return;
            }

            await this.queue.add("add-to-queue", {
                spaceId,
                userId : currentUser.userId,
                url,
                existingActiveStream : previousQueueLength
            });

        }


    }

    async payAndPlayNext(spaceId : string , userId : string , url : string){
        const creatorId = this.spaces.get(spaceId)?.creatorId;
        console.log("payAndPlayNext",creatorId, userId);
        let targetUser = this.users.get(userId);
        if(!targetUser || !creatorId){
            return;
        }

        const extractedId = getVideoId(url);

        if(!extractedId){
            targetUser?.ws.forEach((ws)=>{
                ws.send(
                    JSON.stringify({
                        type: "error",
                        data:{
                            message : "Invalid YouTube URL"
                        }
                    })
                )
            });
            return;
        }

        const res = await youtubesearchapi.GetVideoDetails(extractedId);

        if(res.thumbnail){
            const thumbnails =  res.thumbnail.thumbnails;
            thumbnails.sort((a: {width:number}, b: {width:number})=>
                a.width < b.width? -1 : 1
            );

            const stream = await this.prisma.stream.create({
                data : {
                    id: crypto.randomUUID(),
                    userId: creatorId,
                    url: url,
                    extractedId,
                    type: "Youtube",
                    addedBy: userId,
                    title: res.title ?? "Cant find video",
                    smallImg:
                      (thumbnails.length > 1
                        ? thumbnails[thumbnails.length - 2].url
                        : thumbnails[thumbnails.length - 1].url) ??
                      "https://cdn.pixabay.com/photo/2024/02/28/07/42/european-shorthair-8601492_640.jpg",
                    bigImg:
                      thumbnails[thumbnails.length - 1].url ??
                      "https://cdn.pixabay.com/photo/2024/02/28/07/42/european-shorthair-8601492_640.jpg",
                    spaceId: spaceId,
                }
            });

            await Promise.all([
                this.prisma.currentStream.upsert({
                    where : {
                        spaceId: spaceId,
                    },
                    update : {
                        spaceId : spaceId,
                        userId,
                        streamId : stream.id
                    },
                    create :{
                        id : crypto.randomUUID(),
                        spaceId : spaceId,
                        userId,
                        streamId : stream.id,
                    }
                }),
                this.prisma.stream.update({
                    where:{
                        id : stream.id,
                    },
                    data :{
                        played: true,
                        playedTs: new Date(),
                    }
                })
            ]);

            await this.publisher.publish(
                spaceId,
                JSON.stringify({
                    type : "play-next",
                })
            );

        }





    }

    async processJob(job: Job){
        const {data , name} = job;
        if(name === "cast-vote"){
            await StreamManager.getInstance().adminCastVote(
                data.creatorId,
                data.userId,
                data.streamId,
                data.vote,
                data.spaceId,
            );
        } else if( name === "add-to-queue"){
            await StreamManager.getInstance().adminAddStreamHandler(
                data.spaceId,
                data.userId,
                data.url,
                data.existingActiveStream,
            )
        } else if(name === "play-next"){
            await StreamManager.getInstance().adminPlayNext(data.spaceId , data.userId);

        }else if(name === "remove-song"){
            await StreamManager.getInstance().adminRemoveSong(
                data.spaceId,
                data.userId,
                data.streamId,
            )
        }else if(name === "empty-queue"){
            await StreamManager.getInstance().adminEmptyQueue(data.spaceId);
        }   
    }

    async adminCastVote(creatorId : string , userId : string , streamId : string , vote : string , spaceId : string){
        console.log(process.pid + " adminCastVote");
        if(vote === "upvote"){
            await this.prisma.upvote.create({
                data :{
                    id : crypto.randomUUID();
                    userId,
                    streamId
                }
            });
        }else {
            await this.prisma.upvote.delete({
                where :{
                    userId_streamId :{
                        userId,
                        streamId,
                    }
                }
            });
        }

        await this.redisClient.set(
            `lastVoted-${spaceId}-${userId}`,
            new Date().getTime(),
            {
                EX : TIME_SPAN_FOR_VOTE / 1000,
            }
        );

        await this.publisher.publish(
            spaceId,
            JSON.stringify({
                type: "new-vote",
                data: {
                    streamId,
                    vote,
                    votedId: userId
                },
            })
        )


    }



}