import assert from 'node:assert/strict';
import test from 'node:test';
import { gradeQuiz, validateQuestions } from './index';

const modules = [{ order: 1, topic: 'Ramas' }, { order: 2, topic: 'Conflictos' }];
const question = (moduleOrder: number, correctIndex = 1) => ({
  question: `Pregunta ${moduleOrder}`, options: ['a', 'b', 'c', 'd'], correctIndex, explanation: 'porque sí', moduleOrder,
});

test('validateQuestions descarta preguntas mal formadas y asigna el tema del módulo', () => {
  const questions = validateQuestions({ questions: [
    question(1), question(2), question(1),
    { question: 'sin opciones', options: ['a'], correctIndex: 0 },
    { ...question(1), correctIndex: 7 },
  ] }, modules);
  assert.equal(questions.length, 3);
  assert.equal(questions[1]?.moduleTopic, 'Conflictos');
});

test('validateQuestions falla si el modelo devuelve menos de 3 preguntas válidas', () => {
  assert.throws(() => validateQuestions({ questions: [question(1)] }, modules), /No se pudo generar/);
});

test('gradeQuiz calcula la nota, el aprobado y el tema a repasar', () => {
  const questions = validateQuestions({ questions: [question(1), question(1), question(2), question(2), question(2)] }, modules);
  const graded = gradeQuiz(questions, [1, 1, 0, 1, 0]);
  assert.equal(graded.correct, 3);
  assert.equal(graded.score, 60);
  assert.equal(graded.passed, false);
  assert.deepEqual(graded.recommendation, { moduleTopic: 'Conflictos', missed: 2 });
  assert.equal(gradeQuiz(questions, [1, 1, 1, 1, 1]).passed, true);
});

test('gradeQuiz trata respuestas faltantes o inválidas como incorrectas', () => {
  const questions = validateQuestions({ questions: [question(1), question(1), question(2)] }, modules);
  assert.equal(gradeQuiz(questions, ['x']).correct, 0);
  assert.equal(gradeQuiz(questions, undefined).score, 0);
});
