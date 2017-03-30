'use strict';
var c = require('./common');
const colors = require('colors');
const zmq = require('zeromq');
const _ = require('lodash');

const states = ['WaitNewClientCome','WaitClientAnswer','WaitRestartFeedback','Stopped'];
let currentState = states[0]; //'WaitNewClientCome'
//Can accept the form: $\>node s3 n    # n is the clientNumberLimit
const clientNumberLimit = process.argv.slice(2)[0] || 2; //default is 2
let currentQuestionIndex = 0;

let players = []; // is {clientId, restart}, restart will be one of ['n/a', 'yes', 'no']
let answersFromClients = []; // is { clientId, questionIndex , answerOfClient}
let questions = [
    { // questionIndex will be 0 for this question
      questionItem: 'Question 1: When Canada was founded? \na: July 1,1867.         \nb: July 1,1868.',
      correctAnswer: 'a'
    },
    // {
    //   questionItem: 'Question 2: What is the capital of Canada before Ottawa? \na: Newfoundland and Labrador. \nb: Quebec City.',
    //   correctAnswer: 'b'
    // },
    // {
    //   questionItem: 'Question 3: Who is the first prime minister of canada? \na: John A. Macdonald. \nb: Alexander Mackenzie.',
    //   correctAnswer: 'a'
    // }
  ];

// create publisher endpoint
const publisher = zmq.socket('pub');
publisher.bind('tcp://*:5432', function () { });

const responder = zmq.socket('rep');
responder.bind('tcp://*:5433', function () { });

responder.on('message', function (data) {
  let message = JSON.parse(data.toString());
  if(!c.isMessageValid(message)){
    c.logError("Invalid message: " + data);
    handleUnexpectedMessage(data,responder);
    return false;
  }
  switch (currentState) {
    case 'WaitNewClientCome':
      // only allow new client to connect, will drop message from already connected client
      if (message.type == 'connect') // message.hasOwnProperty('connect')
      {
        handleNewPlayerConnectRequest(message);
      }
      else 
      {
        handleUnexpectedMessage(data, responder);
      }
      break;
    case 'WaitClientAnswer':
      // only allow player not answered answer question, will drop message other than this
      if (message.type == 'question' && !_.find(answersFromClients,
          answer => answer.clientId == message.clientId &&
            answer.questionIndex == currentQuestionIndex)) 
      {
        handlePlayerAnswerRequest(message);
      }
      else if (message.type == 'connect'){
        handleInvalidConnectRequest(responder);
      }
      else {
        handleUnexpectedMessage(data, responder);
      }
      break;
    case 'WaitRestartFeedback':
      if (message.type == 'restart' && message.clientId)
      {
        handleRestartRequest(message);
      }
      else if (message.type == 'connect'){
        handleInvalidConnectRequest(responder);
      }      
      else{
        handleUnexpectedMessage(data, responder);
      }
      break;
    case 'Stopped':
      sendConcretErrorMessage("Sorry, we already stopped.",responder);
      break;
    default:
      c.logError('Should not be here, please check source code!!!');
  }
});

// Will echo back {type: 'connect', clientId: player.clientId}
function handleNewPlayerConnectRequest(message) {
  let player = {
    clientId: players.length + 1,
    restart: 'n/a',  
  };
  responder.send(JSON.stringify({ // send confirmation & id to the new player
    type: 'connect',
    clientId: player.clientId
  }));
  players.push(player);
  c.logInfo('Player ' + players.length + ' connected.');
  if (players.length == clientNumberLimit) { // Got enough players now, send question to player and change state
    setTimeout( () =>
      {
        if (publishNextQuestionToPlayers()) { // successfully send quesiton to players
          currentState = 'WaitClientAnswer';
        }
        else { // run out of questions
          outputSummary();
          publishRestartToPlayers();
          currentState = 'WaitRestartFeedback';
        }
      },100);
  }
  else // still waiting the rest
  {
    c.logInfo('Waiting for other ' + (clientNumberLimit - players.length)
      + ' to begin.');
  }
}

function handleInvalidConnectRequest(responder)
{
  sendConcretErrorMessage("List is full, maybe next time?", responder);
}

function handlePlayerAnswerRequest(message) {
  let content = 'Player ' + message.clientId + ' answered: '
    + message.answer + ' for question ' + (currentQuestionIndex + 1) +
    ', answer should be ' +
    questions[currentQuestionIndex].correctAnswer;
  c.logInfo(content);
  responder.send(JSON.stringify({type: 'information', content: content}));
  answersFromClients.push({
    clientId: message.clientId,
    questionIndex: currentQuestionIndex,
    answerOfClient: message.answer
  });
  if (_.filter(answersFromClients,
    answer => answer.questionIndex ==
      currentQuestionIndex).length == clientNumberLimit) 
  { // all the players have answered question, then go to next question
    currentQuestionIndex++;
    
    if (!publishNextQuestionToPlayers()) 
    { // run out of questions, ask players if want to play again.
      outputSummary();
      publishRestartToPlayers();
      _.forEach(players, player=>player.restart='n/a');
      currentState = 'WaitRestartFeedback';
    }
  }
}

function handleRestartRequest(message) {
  if(message.answer && 
    _.includes(message.answer.toLowerCase(),'y'))
  { // the player agreed play again
    players[message.clientId-1].restart = 'yes';
    c.logInfo("Player " + message.clientId + " agreed to play another round.");
    responder.send(JSON.stringify({
      type: 'information', 
      content: "Player " +  message.clientId + " agreed to play another round."}));
    if(_.every(players, (player)=>player.restart=='yes')) // all players agreed
    {
      c.logOK("All players agreed to play another round, let's do it.");
      currentQuestionIndex = 0;
      answersFromClients = [];
      setTimeout( () =>
        {
          if (publishNextQuestionToPlayers()) { // successfully send quesiton to players
            currentState = 'WaitClientAnswer';
          }
          else { // run out of questions
            outputSummary();
            publishRestartToPlayers();
            currentState = 'WaitRestartFeedback';
          }
        },100); 
    }
  } else if(message.answer && 
    _.includes(message.answer.toLowerCase(),'n'))
  { // the player denied play again
    players[message.clientId-1].restart = 'no';
    c.logError("Player " + message.clientId + " disagreed to play another round.");
    responder.send(JSON.stringify({
      type: 'information', 
      content: "Player " + message.clientId + " disagreed to play another round."}));
    publishStopToPlayers();
    currentState = 'Stopped';
    shutDown();
  }
  else{
    handleUnexpectedMessage(data, responder);
  }
}

// Will send message to player {type: 'question', question: question.questionItem}
function publishNextQuestionToPlayers() {
  if (currentQuestionIndex < questions.length) {
    let question = questions[currentQuestionIndex];
    publisher.send(JSON.stringify({
      type: 'question',
      question: question.questionItem
    }));
    c.logOK("Question " + (currentQuestionIndex+1) + " now");
    return true;
  }
  else {
    return false;
  }
}

function publishStopToPlayers(){
  publisher.send(JSON.stringify({
      type: 'stop',
    }));
}

function publishRestartToPlayers(){
  publisher.send(JSON.stringify({
      type: 'restart?',
    }));
}

function outputSummary() {
  _.forEach(players,(player)=>{
    c.logWarn("Player " + player.clientId + " answered " + 
      _.filter(answersFromClients, (answer)=> 
        answer.clientId==player.clientId &&
        questions[answer.questionIndex].correctAnswer == 
          answer.answerOfClient).length + " right answers of " +
          questions.length + " questions");
  });
}

function handleUnexpectedMessage(data, responder)
{
  c.logWarn('Drop illegal message: ' + data.toString());
  sendConcretErrorMessage('Not allowed action',responder);
}

function sendConcretErrorMessage(reason, responder){
  responder.send(JSON.stringify({ 
    type: 'error',
    reason: reason
  }));  
}

function shutDown(){
  c.logWarn('Shutting down...');
  publisher.close();
  responder.close();
  process.exit();  
}

// close connections when the Node process ends
process.on('SIGINT', shutDown);

c.setTerminalTitle("Server");

c.logInfo('Waiting for other ' + 
  (clientNumberLimit - players.length) + ' to begin.');