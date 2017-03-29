"use strict";
const c = require('./common');
const zmq = require('zeromq');
const colors = require('colors');

const states = ['WaitServerAcceptance','WaitNextQuestion',
              'WaitInputAnswer','Stopped'];
let currentState = 'WaitServerAcceptance';

var player;

// create subscriber endpoint
const subscriber = zmq.socket('sub');
subscriber.subscribe('');
// handle messages from publisher
subscriber.on('message', function (data) {
  let message = JSON.parse(data);
  if(message.type && message.type=='question' &&
  player && player.clientId)
  {
    c.l(message.question);
    c.logInfo("Please input your answer: ");
    currentState = 'WaitInputAnswer';
  }
  else if(message.type=='stop'){
    currentState = 'Stopped';
    c.logOK('End of this session now, thank you!');
  }
  else
  {
    c.logError("Unknown published message:" + data);
  }
});
// connect to publisher
subscriber.connect('tcp://localhost:5432');

// set up request/reply
const request = zmq.socket('req');
request.connect('tcp://localhost:5433');
// handle messages from server
request.on('message', function (data) {
  let message = JSON.parse(data);
  if(!c.isMessageValid(message)){
    c.logError("Invalid message: " + message);
    return false;
  }
  switch (currentState) {
    case 'WaitServerAcceptance':
      if(message.type=='connect'){
        handleNewPlayerConnectAnswer(message);
      }else if(message.type=='error'){ 
        // fail to connect, set to Stopped
        c.logError(message.reason);
        currentState = 'Stopped'; 
      }else{
        handleUnexpectedMessage(data, request);
      }
      break; 
    case 'WaitNextQuestion':
      if(message.type=='stop'){
        currentState = 'Stopped'; 
        subscriber.close();
        request.close();
        process.exit();
      }
      else{
        handleUnexpectedMessage(data, request); 
      }
      break;
    case 'WaitInputAnswer':
      // should not receive response
      handleUnexpectedMessage(data,request);
      break;
    case 'Stopped':
      handleUnexpectedMessage(data,request);
      break;
    default:
      c.logError('Should not be here!!!');
  }
});
request.send(JSON.stringify({ type: 'connect' }));

process.stdin.on('data', function (userInput) {
  if(currentState=='WaitInputAnswer')
  {
    let input = userInput.toString().trim();
    let message = {};
    message.type = 'question';
    message.clientId = player.clientId;
    message.answer = input;
    request.send(JSON.stringify(message));
    currentState='WaitNextQuestion';
  }
  else
  {
    c.logWarn('No need to input anything dude.');
  }
});

function handleNewPlayerConnectAnswer(message) {
  player = {
    clientId: message.clientId,
  };
  currentState = 'WaitNextQuestion';
}

function handleUnexpectedMessage(data, request)
{
  let msg = JSON.parse(data);
  if(msg.type=="information"){
    c.l(msg.content);
    return;
  }
  c.logWarn('Drop illegal message: ' + data.toString());
}

// close connections when the Node process ends
process.on('SIGINT', function () {
  c.logWarn('Shutting down...'.yellow);
  subscriber.close();
  request.close();
  process.exit();
});
